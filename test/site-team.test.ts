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

const ALL: Permission[] = ['sites.view', 'sites.update', 'sites.delete', 'employees.delete']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, job_title, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 'Muratore', 2800), ($1, 'Anna', 'Bassi', null, 3000)
     returning id`,
    [company.id],
  )
  const siteId = site.rows[0]?.id ?? ''
  return {
    browser,
    company,
    siteId,
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    url: `/api/companies/${company.slug}/sites/${siteId}/team`,
  }
}

type Team = { data: { employee_id: string; last_name: string }[] }

describe('site team', () => {
  it('replaces the team and lists it by name, without costs', async () => {
    const { browser, url, verdi, bassi } = await scene()
    expect((await browser.call('GET', url)).json<Team>().data).toEqual([])
    const res = await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi, verdi] } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Team>().data.map((m) => m.last_name)).toEqual(['Bassi', 'Verdi'])
    expect(JSON.stringify(res.json())).not.toContain('cost')
    const after = await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(after.json<Team>().data.map((m) => m.employee_id)).toEqual([verdi])
    expect((await browser.call('GET', url)).json<Team>().data).toHaveLength(1)
  })

  it.each([
    ['no list', {}],
    ['a list of numbers', { employee_ids: [1] }],
    ['too many', { employee_ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }],
    ['an unknown employee', { employee_ids: [crypto.randomUUID()] }],
  ])('refuses %s', async (_label, body) => {
    const { browser, url } = await scene()
    const res = await browser.call('PUT', url, { body })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { employee_ids: [expect.any(String)] } })
  })

  it('tells who is away today; why only with employees.view', async () => {
    const { browser, company, url, verdi, bassi } = await scene([...ALL, 'employees.view'])
    await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi] } })
    // Verdi sick from yesterday to today, Bassi with two hours of leave today and a holiday
    // starting tomorrow. Today is the Italian date.
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours)
       select $1, x.employee_id, x.kind, d.today + x.from_day, d.today + x.to_day, x.hours
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ($2::uuid, 'sick_leave', -1, 0, null::numeric),
                 ($3::uuid, 'leave', 0, 0, 2),
                 ($3::uuid, 'vacation', 1, 5, null)) as x (employee_id, kind, from_day, to_day, hours)`,
      [company.id, verdi, bassi],
    )
    type Members = {
      data: {
        last_name: string
        away: boolean
        absence: string | null
        absence_hours: string | null
      }[]
    }
    const rows = (res: { json: <T>() => T }) =>
      res.json<Members>().data.map((m) => [m.last_name, m.away, m.absence, m.absence_hours])
    const seen = await browser.call('GET', url)
    expect(seen.statusCode).toBe(200)
    expect(rows(seen)).toEqual([
      ['Bassi', false, 'leave', '2.00'],
      ['Verdi', true, 'sick_leave', null],
    ])

    // A capo cantiere with sites.view only knows who is away, not why.
    const chief = new Browser(ctx.app)
    const role = await fx.role(company.id, 'Capo cantiere', ['sites.view', 'sites.update'])
    const person = await fx.user()
    await fx.member(person.id, company.id, role)
    await chief.signIn(person.email)
    const hidden = await chief.call('GET', url)
    expect(rows(hidden)).toEqual([
      ['Bassi', false, null, null],
      ['Verdi', true, null, null],
    ])
    expect(hidden.body).not.toContain('sick_leave')
    const replaced = await chief.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(rows(replaced)).toEqual([['Verdi', true, null, null]])

    // Ended absences, or of another company, do not count.
    const other = await scene()
    await other.browser.call('PUT', other.url, { body: { employee_ids: [other.verdi] } })
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       select $1, $2, 'vacation', d - 10, d - 1
       from (select (now() at time zone 'Europe/Rome')::date as d) x`,
      [other.company.id, other.verdi],
    )
    const free = await other.browser.call('GET', other.url)
    expect(rows(free)).toEqual([['Verdi', false, null, null]])
  })

  it('tells who has an expired document, not which one', async () => {
    const { browser, company, url, verdi, bassi } = await scene()
    await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi] } })
    // Verdi: the medical check expired yesterday. Bassi: a course expired, but the refresher is
    // on file, and the first aid expires today (still valid).
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on, notes)
       select $1, x.employee_id, x.kind, d.today + x.days, 'n. 81'
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ($2::uuid, 'medical_check', -1),
                 ($3::uuid, 'safety_training', -10),
                 ($3::uuid, 'safety_training', 300),
                 ($3::uuid, 'first_aid', 0)) as x (employee_id, kind, days)`,
      [company.id, verdi, bassi],
    )
    type Members = { data: { last_name: string; documents_expired: boolean }[] }
    const rows = (res: { json: <T>() => T }) =>
      res.json<Members>().data.map((m) => [m.last_name, m.documents_expired])
    const seen = await browser.call('GET', url)
    expect(seen.statusCode).toBe(200)
    expect(rows(seen)).toEqual([
      ['Bassi', false],
      ['Verdi', true],
    ])
    // Without employees.view nothing says which document, nor its notes.
    expect(seen.body).not.toContain('medical_check')
    expect(seen.body).not.toContain('n. 81')
    const replaced = await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(rows(replaced)).toEqual([['Verdi', true]])

    // Documents of another company never reach this team.
    const other = await scene()
    await other.browser.call('PUT', other.url, { body: { employee_ids: [other.verdi] } })
    expect(rows(await other.browser.call('GET', other.url))).toEqual([['Verdi', false]])
  })

  it('an employee of another company cannot join; another company’s site is not found', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('PUT', mine.url, {
      body: { employee_ids: [theirs.verdi] },
    })
    expect(res.statusCode).toBe(422)
    const other = `/api/companies/${mine.company.slug}/sites/${theirs.siteId}/team`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('PUT', other, { body: { employee_ids: [mine.verdi] } })).statusCode,
    ).toBe(404)
    expect((await theirs.browser.call('GET', theirs.url)).json<Team>().data).toEqual([])
  })

  it('an employee in a team cannot be deleted; deleting the site frees them', async () => {
    const { browser, company, url, verdi, siteId } = await scene()
    await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    const employee = `/api/companies/${company.slug}/employees/${verdi}`
    const refused = await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'has_documents' })
    const site = `/api/companies/${company.slug}/sites/${siteId}`
    expect(
      (await browser.call('DELETE', site, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
    expect(
      (await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
  })

  it('exports the documents of the team for the safety coordinator', async () => {
    const { browser, company, url, verdi, bassi } = await scene([...ALL, 'employees.view'])
    await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi] } })
    // Verdi: a course renewed (the old one expired), the medical check expiring in ten days with
    // its scan, a license without expiry. Bassi: nothing. Another employee, not in the team, has
    // a document that must not appear.
    const outsider = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name)
       values ($1, 'Piero', 'Fuori') returning id`,
      [company.id],
    )
    const docs = await ctx.owner.query<{ id: string; kind: string }>(
      `insert into public.employee_documents
         (company_id, employee_id, kind, description, issued_on, expires_on, notes)
       select $1, x.employee_id, x.kind, x.description, date '2026-01-15',
         d.today + x.days, x.notes
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ($2::uuid, 'safety_training', 'Corso base', -20, '=1+1'),
                 ($2::uuid, 'safety_training', 'Aggiornamento', 400, null),
                 ($2::uuid, 'medical_check', null, 10, 'n. 81'),
                 ($2::uuid, 'license', 'Gru', null, null),
                 ($3::uuid, 'first_aid', 'Segreto', 50, null))
           as x (employee_id, kind, description, days, notes)
       returning id, kind`,
      [company.id, verdi, outsider.rows[0]?.id],
    )
    const medical = docs.rows.find((r) => r.kind === 'medical_check')?.id
    await ctx.owner.query(
      `insert into public.employee_document_files
         (document_id, company_id, file_name, content_type, size_bytes, data)
       values ($1, $2, 'idoneita.pdf', 'application/pdf', 3, 'pdf')`,
      [medical, company.id],
    )
    const res = await browser.call('GET', `${url}/documents/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="documenti-squadra.csv"')
    const day = (days: number) => {
      const d = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }).split(',')[0] ?? '',
      )
      d.setDate(d.getDate() + days)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
    }
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
    expect(lines).toEqual([
      'Cognome;Nome;Mansione;Documento;Descrizione;Rilascio;Scadenza;Stato;Note;File',
      'Bassi;Anna;;;;;;Nessun documento;;',
      `Verdi;Luca;Muratore;Idoneità sanitaria;;15/01/2026;${day(10)};In scadenza;n. 81;Sì`,
      `Verdi;Luca;Muratore;Formazione sicurezza;Aggiornamento;15/01/2026;${day(400)};Valido;;No`,
      `Verdi;Luca;Muratore;Formazione sicurezza;Corso base;15/01/2026;${day(-20)};Rinnovato;'=1+1;No`,
      'Verdi;Luca;Muratore;Patentino;Gru;15/01/2026;;Senza scadenza;;No',
    ])
    expect(res.body).not.toContain('Segreto')

    // Without the renewal the old course is expired.
    const renewal = docs.rows.find((r) => r.kind === 'safety_training')?.id
    await ctx.owner.query(
      "delete from public.employee_documents where kind = 'safety_training' and employee_id = $1 and description = 'Aggiornamento'",
      [verdi],
    )
    expect(renewal).toBeDefined()
    const after = await browser.call('GET', `${url}/documents/export`)
    expect(after.body).toContain(`Corso base;15/01/2026;${day(-20)};Scaduto;`)
  })

  it('the team documents need employees.view; another company’s site is not found', async () => {
    const chief = await scene(['sites.view'])
    const refused = await chief.browser.call('GET', `${chief.url}/documents/export`)
    expect(refused.statusCode).toBe(403)
    const blind = await scene(['employees.view'])
    expect((await blind.browser.call('GET', `${blind.url}/documents/export`)).statusCode).toBe(404)
    const mine = await scene([...ALL, 'employees.view'])
    const theirs = await scene()
    await theirs.browser.call('PUT', theirs.url, { body: { employee_ids: [theirs.verdi] } })
    const other = `/api/companies/${mine.company.slug}/sites/${theirs.siteId}/team/documents/export`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', `${mine.url}/documents/export`)).statusCode).toBe(401)
  })

  it('reading needs sites.view, changing sites.update', async () => {
    const reader = await scene(['sites.view'])
    expect((await reader.browser.call('GET', reader.url)).statusCode).toBe(200)
    expect(
      (await reader.browser.call('PUT', reader.url, { body: { employee_ids: [] } })).statusCode,
    ).toBe(403)
    const blind = await scene(['employees.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(404)
  })
})

describe('sites by documents of their team', () => {
  it('filters the list and the export; expiring only with employees.view', async () => {
    const { browser, company, url, verdi, bassi } = await scene([...ALL, 'employees.view'])
    await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    const sites = await ctx.owner.query<{ id: string }>(
      `insert into public.sites (company_id, name) values ($1, 'Altro'), ($1, 'Rinnovato'),
         ($1, 'Vuoto') returning id`,
      [company.id],
    )
    const [altro, rinnovato] = sites.rows.map((r) => r.id)
    const people = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name)
       values ($1, 'Rita', 'Neri') returning id`,
      [company.id],
    )
    const neri = people.rows[0]?.id ?? ''
    await ctx.owner.query(
      `insert into public.site_team (company_id, site_id, employee_id)
       values ($1, $2, $3), ($1, $4, $5)`,
      [company.id, altro, bassi, rinnovato, neri],
    )
    // Verdi (Villetta) expired yesterday; Bassi (Altro) expires in 30 days; Neri (Rinnovato)
    // has an expired course renewed; Vuoto has no team.
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       select $1, x.employee_id, x.kind, (now() at time zone 'Europe/Rome')::date + x.days
       from (values ($2::uuid, 'medical_check', -1),
                    ($3::uuid, 'safety_training', 30),
                    ($4::uuid, 'safety_training', -10),
                    ($4::uuid, 'safety_training', 200)) as x (employee_id, kind, days)`,
      [company.id, verdi, bassi, neri],
    )
    // Another company's site with an expired team member stays out.
    const theirs = await scene()
    await theirs.browser.call('PUT', theirs.url, { body: { employee_ids: [theirs.verdi] } })
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       values ($1, $2, 'medical_check', date '2026-01-16')`,
      [theirs.company.id, theirs.verdi],
    )

    const base = `/api/companies/${company.slug}/sites`
    const names = async (value: string) => {
      const res = await browser.call('GET', `${base}?sort=name&filter[team_documents]=${value}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: { name: string }[] }>().data.map((s) => s.name)
    }
    expect(await names('expired')).toEqual(['Villetta'])
    expect(await names('expiring')).toEqual(['Altro'])
    const csv = await browser.call('GET', `${base}/export?filter[team_documents]=expiring`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Altro')
    expect(csv.body).not.toContain('Villetta')

    const bad = await browser.call('GET', `${base}?filter[team_documents]=scaduto`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ errors: { 'filter[team_documents]': [expect.any(String)] } })

    // A site chief sees the expired ones, as in the team, but not the expiring ones.
    const chief = await scene(['sites.view'])
    await ctx.owner.query(
      `insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)`,
      [chief.company.id, chief.siteId, chief.verdi],
    )
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       values ($1, $2, 'medical_check', date '2026-01-16')`,
      [chief.company.id, chief.verdi],
    )
    const chiefBase = `/api/companies/${chief.company.slug}/sites`
    const seen = await chief.browser.call('GET', `${chiefBase}?filter[team_documents]=expired`)
    expect(seen.statusCode).toBe(200)
    expect(seen.json<{ data: { name: string }[] }>().data.map((s) => s.name)).toEqual(['Villetta'])
    expect(
      (await chief.browser.call('GET', `${chiefBase}?filter[team_documents]=expiring`)).statusCode,
    ).toBe(403)
    expect(
      (await chief.browser.call('GET', `${chiefBase}/export?filter[team_documents]=expiring`))
        .statusCode,
    ).toBe(403)

    // The dashboard counts the active sites with an expired team member; null without sites.view.
    const dashboard = `/api/companies/${company.slug}/dashboard`
    const counted = async () => {
      const res = await browser.call('GET', dashboard)
      expect(res.statusCode).toBe(200)
      return res.json<{ employees: { active_sites_expired: number | null } }>().employees
        .active_sites_expired
    }
    await ctx.owner.query("update public.sites set status = 'active' where company_id = $1", [
      company.id,
    ])
    await ctx.owner.query("update public.sites set status = 'active' where company_id = $1", [
      theirs.company.id,
    ])
    expect(await counted()).toBe(1)
    await ctx.owner.query(
      "update public.sites set status = 'suspended' where company_id = $1 and name = 'Villetta'",
      [company.id],
    )
    expect(await counted()).toBe(0)
    const office = await fx.user()
    await fx.member(
      office.id,
      company.id,
      await fx.role(company.id, 'Personale', ['employees.view']),
    )
    const officeBrowser = new Browser(ctx.app)
    await officeBrowser.signIn(office.email)
    const seenByOffice = await officeBrowser.call('GET', dashboard)
    expect(seenByOffice.statusCode).toBe(200)
    expect(
      seenByOffice.json<{ employees: { active_sites_expired: number | null } }>().employees
        .active_sites_expired,
    ).toBeNull()
  })

  it('marks the sites with an expired team document, without changing the ETag', async () => {
    const { browser, company, siteId, url, verdi } = await scene(['sites.view', 'sites.update'])
    const site = `/api/companies/${company.slug}/sites/${siteId}`
    type Flag = { name: string; team_documents_expired: boolean }
    const before = await browser.call('GET', site)
    expect(before.json<Flag>().team_documents_expired).toBe(false)
    const etag = before.headers.etag
    await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       values ($1, $2, 'medical_check', (now() at time zone 'Europe/Rome')::date - 1)`,
      [company.id, verdi],
    )
    const after = await browser.call('GET', site)
    expect(after.statusCode).toBe(200)
    expect(after.json<Flag>().team_documents_expired).toBe(true)
    expect(after.headers.etag).toBe(etag)
    const list = await browser.call('GET', `/api/companies/${company.slug}/sites`)
    expect(
      list.json<{ data: Flag[] }>().data.map((s) => [s.name, s.team_documents_expired]),
    ).toEqual([['Villetta', true]])
    const csv = await browser.call('GET', `/api/companies/${company.slug}/sites/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\r\n')[1]).toMatch(/;Sì;$/)
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
        team_documents_expired: false,
      },
      headers: { 'if-match': String(etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Flag>().team_documents_expired).toBe(true)

    // Another company's site never sees this team.
    const other = await scene()
    const theirs = await other.browser.call(
      'GET',
      `/api/companies/${other.company.slug}/sites/${other.siteId}`,
    )
    expect(theirs.json<Flag>().team_documents_expired).toBe(false)
  })
})
