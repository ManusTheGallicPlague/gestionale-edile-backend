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
    expect(res.body).not.toContain('1234')
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
