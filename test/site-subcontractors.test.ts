import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function scene(permissions: Permission[] = ['sites.view', 'suppliers.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta'), ($1, 'Altro') returning id",
    [company.id],
  )
  const siteId = sites.rows[0]?.id ?? ''
  return {
    browser,
    company,
    siteId,
    otherSiteId: sites.rows[1]?.id ?? '',
    url: `/api/companies/${company.slug}/sites/${siteId}/subcontractors/documents/export`,
  }
}

/** A supplier; with a cost or an order on the given site. */
async function supplier(
  companyId: string,
  name: string,
  subcontractor: boolean,
  link: { cost?: string; order?: string } = {},
) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.suppliers (company_id, name, vat_number, subcontractor, archived_at)
     values ($1, $2, $3, $4, case when $2 = 'Archiviata' then now() end) returning id`,
    [
      companyId,
      name,
      subcontractor ? `IT${Math.floor(Math.random() * 1e11)}` : null,
      subcontractor,
    ],
  )
  const id = rows[0]?.id ?? ''
  if (link.cost) {
    await ctx.owner.query(
      `insert into public.site_costs (company_id, site_id, supplier_id, cost_date, category,
         description, amount_cents) values ($1, $2, $3, '2026-10-01', 'subcontract', 'x', 123456)`,
      [companyId, link.cost, id],
    )
  }
  if (link.order) {
    await ctx.owner.query(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         site_id, order_date) values ($1, 2026, floor(random() * 1e6)::int + 1, $2, $3, '2026-10-01')`,
      [companyId, id, link.order],
    )
  }
  return id
}

describe('documents of the subcontractors of a site', () => {
  it('lists the subcontractors with a cost or an order on the site, with their documents', async () => {
    const { browser, company, siteId, otherSiteId, url } = await scene()
    const bianchi = await supplier(company.id, 'Bianchi Scavi', true, { cost: siteId })
    await supplier(company.id, 'Archiviata', true, { order: siteId })
    await supplier(company.id, 'Altrove', true, { cost: otherSiteId })
    await supplier(company.id, 'Cementi', false, { cost: siteId, order: siteId })
    await supplier(company.id, 'Nessun legame', true)
    await ctx.owner.query(
      `insert into public.supplier_documents
         (company_id, supplier_id, kind, description, issued_on, expires_on, notes)
       select $1, $2, x.kind, x.description, date '2026-01-15', d.today + x.days, x.notes
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ('durc', null, -40, 'vecchio'),
                 ('durc', null, 80, null),
                 ('insurance', 'RCT', 5, '@polizza'),
                 ('chamber_extract', null, null, null)) as x (kind, description, days, notes)`,
      [company.id, bianchi],
    )
    const durc = await ctx.owner.query<{ id: string }>(
      `select id from public.supplier_documents
       where supplier_id = $1 and kind = 'durc' order by expires_on desc limit 1`,
      [bianchi],
    )
    await ctx.owner.query(
      `insert into public.supplier_document_files
         (document_id, company_id, file_name, content_type, size_bytes, data)
       values ($1, $2, 'durc.pdf', 'application/pdf', 3, 'pdf')`,
      [durc.rows[0]?.id, company.id],
    )
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="documenti-subappaltatori.csv"',
    )
    const days = await ctx.owner.query<{ d: string }>(
      `select to_char((now() at time zone 'Europe/Rome')::date + x, 'DD/MM/YYYY') as d
       from unnest(array[-40, 80, 5]) as x`,
    )
    const [old, renewed, soon] = days.rows.map((r) => r.d)
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
    const vat = lines[2]?.split(';')[1] ?? ''
    expect(lines).toEqual([
      'Subappaltatore;Partita IVA;Documento;Descrizione;Rilascio;Scadenza;Stato;Note;File',
      'Archiviata;' + (lines[1]?.split(';')[1] ?? '') + ';;;;;Nessun documento;;',
      `Bianchi Scavi;${vat};DURC;;15/01/2026;${renewed};Valido;;Sì`,
      `Bianchi Scavi;${vat};DURC;;15/01/2026;${old};Rinnovato;vecchio;No`,
      `Bianchi Scavi;${vat};Visura camerale;;15/01/2026;;Senza scadenza;;No`,
      `Bianchi Scavi;${vat};Assicurazione;RCT;15/01/2026;${soon};In scadenza;'@polizza;No`,
    ])
    expect(vat).toMatch(/^IT\d+$/)
    expect(res.body).not.toMatch(/1234[.,]56/)
  })

  it('needs suppliers.view; another company’s site is not found', async () => {
    const chief = await scene(['sites.view'])
    expect((await chief.browser.call('GET', chief.url)).statusCode).toBe(403)
    const blind = await scene(['suppliers.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(404)

    const mine = await scene()
    const theirs = await scene()
    await supplier(theirs.company.id, 'Loro', true, { cost: theirs.siteId })
    const other = `/api/companies/${mine.company.slug}/sites/${theirs.siteId}/subcontractors/documents/export`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    const own = await mine.browser.call('GET', mine.url)
    expect(own.body).not.toContain('Loro')
    expect(
      (
        await mine.browser.call(
          'GET',
          `/api/companies/${mine.company.slug}/sites/x/subcontractors/documents/export`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await new Browser(ctx.app).call('GET', mine.url)).statusCode).toBe(401)
  })
})

describe('subcontractors of a site', () => {
  const listUrl = (slug: string, site: string) =>
    `/api/companies/${slug}/sites/${site}/subcontractors`

  async function documents(companyId: string, supplierId: string, docs: [string, number | null][]) {
    for (const [kind, days] of docs) {
      await ctx.owner.query(
        `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
         values ($1, $2, $3, date '2026-01-15',
           (now() at time zone 'Europe/Rome')::date + $4::int)`,
        [companyId, supplierId, kind, days],
      )
    }
  }

  it('lists the subcontractors on the site with their compliance', async () => {
    const { browser, company, siteId, otherSiteId } = await scene()
    const ok = await supplier(company.id, 'Bianchi Scavi', true, { cost: siteId })
    const archived = await supplier(company.id, 'Archiviata', true, { order: siteId })
    const late = await supplier(company.id, 'Colombo Impianti', true, { order: siteId })
    const soon = await supplier(company.id, 'Damiani Ponteggi', true, { cost: siteId })
    await supplier(company.id, 'Altrove', true, { cost: otherSiteId })
    await supplier(company.id, 'Cementi', false, { cost: siteId })
    await supplier(company.id, 'Nessun legame', true)
    // The expired DURC was renewed: it does not count any more.
    await documents(company.id, ok, [
      ['durc', -40],
      ['durc', 80],
      ['insurance', 200],
    ])
    await ctx.owner.query(
      `insert into public.supplier_documents (company_id, supplier_id, kind)
       values ($1, $2, 'credit_license')`,
      [company.id, ok],
    )
    await documents(company.id, late, [
      ['durc', -1],
      ['insurance', 10],
    ])
    await documents(company.id, soon, [
      ['durc', 0],
      ['insurance', 30],
    ])
    const res = await browser.call('GET', listUrl(company.slug, siteId))
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: Record<string, unknown>[] }>()
    expect(body.data.map((s) => [s.name, s.archived])).toEqual([
      ['Archiviata', true],
      ['Bianchi Scavi', false],
      ['Colombo Impianti', false],
      ['Damiani Ponteggi', false],
    ])
    const flags = (id: string) => {
      const s = body.data.find((x) => x.supplier_id === id)
      return [s?.documents_expired, s?.documents_expiring, s?.no_valid_durc]
    }
    expect(flags(archived)).toEqual([false, false, true])
    expect(flags(ok)).toEqual([false, false, false])
    expect(flags(late)).toEqual([true, false, true])
    expect(flags(soon)).toEqual([false, true, false])
    // Only the one with a credit-based licence (no expiry) has it valid.
    const licence = (id: string) =>
      body.data.find((x) => x.supplier_id === id)?.no_valid_credit_license
    expect([licence(archived), licence(ok), licence(late), licence(soon)]).toEqual([
      true,
      false,
      true,
      true,
    ])
    expect(body.data[1]?.vat_number).toMatch(/^IT\d+$/)
    expect(res.body).not.toMatch(/1234[.,]56/)
  })

  it('needs suppliers.view; another company’s site is not found', async () => {
    const chief = await scene(['sites.view'])
    expect(
      (await chief.browser.call('GET', listUrl(chief.company.slug, chief.siteId))).statusCode,
    ).toBe(403)
    const blind = await scene(['suppliers.view'])
    expect(
      (await blind.browser.call('GET', listUrl(blind.company.slug, blind.siteId))).statusCode,
    ).toBe(404)

    const mine = await scene()
    const theirs = await scene()
    await supplier(theirs.company.id, 'Loro', true, { cost: theirs.siteId })
    expect(
      (await mine.browser.call('GET', listUrl(mine.company.slug, theirs.siteId))).statusCode,
    ).toBe(404)
    expect(
      (await mine.browser.call('GET', listUrl(theirs.company.slug, theirs.siteId))).statusCode,
    ).toBe(404)
    const own = await mine.browser.call('GET', listUrl(mine.company.slug, mine.siteId))
    expect(own.json()).toEqual({ data: [] })
    expect((await mine.browser.call('GET', listUrl(mine.company.slug, 'x'))).statusCode).toBe(404)
    expect(
      (await new Browser(ctx.app).call('GET', listUrl(mine.company.slug, mine.siteId))).statusCode,
    ).toBe(401)
  })
})

describe('sites by compliance of their subcontractors', () => {
  it('filters the list and the export, only with suppliers.view', async () => {
    const { browser, company, siteId, otherSiteId } = await scene()
    const sites = await ctx.owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'Rinnovato') returning id",
      [company.id],
    )
    const renewedSite = sites.rows[0]?.id ?? ''
    // Villetta: a subcontractor (on an order) with an expired DURC; Altro: one expiring.
    const late = await supplier(company.id, 'Colombo', true, { order: siteId })
    const soon = await supplier(company.id, 'Damiani', true, { cost: otherSiteId })
    const renewed = await supplier(company.id, 'Esposito', true, { cost: renewedSite })
    // A plain supplier with an expired document does not make a site irregular.
    const plain = await supplier(company.id, 'Cementi', false, { cost: renewedSite })
    const doc = (id: string, kind: string, days: number) =>
      ctx.owner.query(
        `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
         values ($1, $2, $3, date '2026-01-15', (now() at time zone 'Europe/Rome')::date + $4::int)`,
        [company.id, id, kind, days],
      )
    await doc(late, 'durc', -1)
    await doc(soon, 'durc', 90)
    await doc(soon, 'insurance', 30)
    await doc(renewed, 'durc', -100)
    await doc(renewed, 'durc', 100)
    await doc(plain, 'durc', -5)
    // Another company's site with an irregular subcontractor stays out.
    const theirs = await scene()
    const loro = await supplier(theirs.company.id, 'Loro', true, { cost: theirs.siteId })
    await ctx.owner.query(
      `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
       values ($1, $2, 'durc', date '2026-01-15', date '2026-01-16')`,
      [theirs.company.id, loro],
    )

    const base = `/api/companies/${company.slug}/sites`
    const names = async (value: string) => {
      const res = await browser.call(
        'GET',
        `${base}?sort=name&filter[subcontractor_compliance]=${value}`,
      )
      expect(res.statusCode).toBe(200)
      return res.json<{ data: { name: string }[] }>().data.map((s) => s.name)
    }
    expect(await names('expired')).toEqual(['Villetta'])
    expect(await names('expiring')).toEqual(['Altro'])
    expect(await names('no_valid_durc')).toEqual(['Villetta'])
    const csv = await browser.call(
      'GET',
      `${base}/export?filter[subcontractor_compliance]=expiring`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Altro')
    expect(csv.body).not.toContain('Villetta')

    const bad = await browser.call('GET', `${base}?filter[subcontractor_compliance]=scaduto`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({
      errors: { 'filter[subcontractor_compliance]': [expect.any(String)] },
    })

    const chief = await scene(['sites.view'])
    const chiefBase = `/api/companies/${chief.company.slug}/sites`
    expect(
      (await chief.browser.call('GET', `${chiefBase}?filter[subcontractor_compliance]=expired`))
        .statusCode,
    ).toBe(403)
    expect(
      (
        await chief.browser.call(
          'GET',
          `${chiefBase}/export?filter[subcontractor_compliance]=expired`,
        )
      ).statusCode,
    ).toBe(403)
    expect((await chief.browser.call('GET', chiefBase)).statusCode).toBe(200)
  })
})

describe('subcontractors_expired in a site', () => {
  it('marks the sites with a subcontractor with an expired document, only with suppliers.view', async () => {
    const { browser, company, siteId, otherSiteId } = await scene([
      'sites.view',
      'sites.update',
      'suppliers.view',
    ])
    const site = `/api/companies/${company.slug}/sites/${siteId}`
    type Flag = { name: string; subcontractors_expired: boolean | null }
    const before = await browser.call('GET', site)
    expect(before.json<Flag>().subcontractors_expired).toBe(false)
    const etag = before.headers.etag
    const doc = (companyId: string, id: string, days: number) =>
      ctx.owner.query(
        `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
         values ($1, $2, 'durc', date '2026-01-15', (now() at time zone 'Europe/Rome')::date + $3::int)`,
        [companyId, id, days],
      )
    // Villetta: a subcontractor on an order with a DURC expired yesterday.
    await doc(company.id, await supplier(company.id, 'Colombo', true, { order: siteId }), -1)
    // Altro: a DURC expired but renewed, and a plain supplier with an expired one.
    const renewed = await supplier(company.id, 'Esposito', true, { cost: otherSiteId })
    await doc(company.id, renewed, -100)
    await doc(company.id, renewed, 100)
    await doc(company.id, await supplier(company.id, 'Cementi', false, { cost: otherSiteId }), -5)

    const after = await browser.call('GET', site)
    expect(after.statusCode).toBe(200)
    expect(after.json<Flag>().subcontractors_expired).toBe(true)
    expect(after.headers.etag).toBe(etag)
    const list = await browser.call('GET', `/api/companies/${company.slug}/sites?sort=name`)
    expect(
      list.json<{ data: Flag[] }>().data.map((s) => [s.name, s.subcontractors_expired]),
    ).toEqual([
      ['Altro', false],
      ['Villetta', true],
    ])
    const csv = await browser.call('GET', `/api/companies/${company.slug}/sites/export?sort=name`)
    expect(csv.statusCode).toBe(200)
    const rows = csv.body.trim().split('\r\n')
    expect(rows[0]).toMatch(/;Subappaltatori con documenti scaduti;CIG;CUP$/)
    expect(rows[1]).toMatch(/^;Altro;.*;No;;$/)
    expect(rows[2]).toMatch(/^;Villetta;.*;Sì;;$/)
    // Sent back in the body it is ignored, and stays computed.
    const updated = await browser.call('PUT', site, {
      body: {
        code: null,
        name: 'Villetta 2',
        client_id: null,
        address: null,
        status: 'planned',
        start_on: null,
        end_on: null,
        budget: null,
        notes: null,
        subcontractors_expired: false,
      },
      headers: { 'if-match': String(etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Flag>().subcontractors_expired).toBe(true)

    // Without suppliers.view it is null everywhere, and the CSV cell is empty.
    const chief = await scene(['sites.view', 'sites.create', 'sites.update'])
    await doc(
      chief.company.id,
      await supplier(chief.company.id, 'Loro', true, { cost: chief.siteId }),
      -1,
    )
    const chiefBase = `/api/companies/${chief.company.slug}/sites`
    const seen = await chief.browser.call('GET', `${chiefBase}/${chief.siteId}`)
    expect(seen.json<Flag>().subcontractors_expired).toBeNull()
    const chiefList = await chief.browser.call('GET', chiefBase)
    expect(chiefList.json<{ data: Flag[] }>().data.map((s) => s.subcontractors_expired)).toEqual([
      null,
      null,
    ])
    const created = await chief.browser.call('POST', chiefBase, {
      body: {
        code: null,
        name: 'Nuovo',
        client_id: null,
        address: null,
        status: 'planned',
        start_on: null,
        end_on: null,
        budget: null,
        notes: null,
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json<Flag>().subcontractors_expired).toBeNull()
    const chiefCsv = await chief.browser.call('GET', `${chiefBase}/export?sort=name`)
    expect(chiefCsv.body.trim().split('\r\n').slice(1)).toEqual([
      expect.stringMatching(/;No;;;$/),
      expect.stringMatching(/;No;;;$/),
      expect.stringMatching(/;No;;;$/),
    ])

    // The other company now has an irregular subcontractor: our Altro stays false.
    const theirs = await browser.call('GET', `/api/companies/${company.slug}/sites/${otherSiteId}`)
    expect(theirs.json<Flag>().subcontractors_expired).toBe(false)
  })
})

describe('active sites with irregular subcontractors in the dashboard', () => {
  it('counts active sites only, once each, with sites.view and suppliers.view', async () => {
    const { browser, company } = await scene()
    const sites = await ctx.owner.query<{ id: string; name: string }>(
      `insert into public.sites (company_id, name, status) values
         ($1, 'Due scaduti', 'active'), ($1, 'Senza DURC', 'active'), ($1, 'Regolare', 'active'),
         ($1, 'Chiuso', 'completed')
       returning id, name`,
      [company.id],
    )
    const site = (name: string) => sites.rows.find((r) => r.name === name)?.id ?? ''
    const doc = (id: string, kind: string, days: number) =>
      ctx.owner.query(
        `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
         values ($1, $2, $3, date '2026-01-15', (now() at time zone 'Europe/Rome')::date + $4::int)`,
        [company.id, id, kind, days],
      )
    // Two subcontractors with an expired DURC on the same site: the site counts once.
    for (const name of ['Uno', 'Due']) {
      await doc(await supplier(company.id, name, true, { cost: site('Due scaduti') }), 'durc', -3)
    }
    // No DURC at all: not expired, but without a valid DURC.
    await supplier(company.id, 'Nuova', true, { order: site('Senza DURC') })
    await doc(await supplier(company.id, 'Ok', true, { cost: site('Regolare') }), 'durc', 60)
    await doc(await supplier(company.id, 'Chiusa', true, { cost: site('Chiuso') }), 'durc', -3)

    const dashboard = `/api/companies/${company.slug}/dashboard`
    const res = await browser.call('GET', dashboard)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ subcontractors: unknown }>().subcontractors).toMatchObject({
      active_sites_expired: 1,
      active_sites_no_valid_durc: 2,
    })
    // The same sites as the list with the filter.
    const listed = await browser.call(
      'GET',
      `/api/companies/${company.slug}/sites?sort=name&filter[status]=active&filter[subcontractor_compliance]=no_valid_durc`,
    )
    expect(listed.json<{ data: { name: string }[] }>().data.map((s) => s.name)).toEqual([
      'Due scaduti',
      'Senza DURC',
    ])
    // The credit-based licence works the same way: only «Ok» has one.
    await ctx.owner.query(
      `insert into public.supplier_documents (company_id, supplier_id, kind)
       select company_id, id, 'credit_license' from public.suppliers
       where company_id = $1 and name = 'Ok'`,
      [company.id],
    )
    const noLicence = await browser.call(
      'GET',
      `/api/companies/${company.slug}/sites?sort=name&filter[status]=active&filter[subcontractor_compliance]=no_valid_credit_license`,
    )
    expect(noLicence.statusCode).toBe(200)
    expect(noLicence.json<{ data: { name: string }[] }>().data.map((s) => s.name)).toEqual([
      'Due scaduti',
      'Senza DURC',
    ])
    // The dashboard counts the same sites, and the subcontractors without one (Ok has it).
    const after = await browser.call('GET', dashboard)
    expect(after.json<{ subcontractors: unknown }>().subcontractors).toMatchObject({
      no_valid_credit_license: 4,
      active_sites_no_valid_credit_license: 2,
    })

    // Another company does not see these sites.
    const theirs = await scene()
    const other = await theirs.browser.call(
      'GET',
      `/api/companies/${theirs.company.slug}/dashboard`,
    )
    expect(other.json<{ subcontractors: unknown }>().subcontractors).toMatchObject({
      active_sites_expired: 0,
      active_sites_no_valid_durc: 0,
      no_valid_credit_license: 0,
      active_sites_no_valid_credit_license: 0,
    })
  })
})
