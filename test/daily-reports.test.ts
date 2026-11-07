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

const ALL: Permission[] = [
  'reports.view',
  'reports.create',
  'reports.update',
  'reports.delete',
  'reports.approve',
  'sites.delete',
  'employees.delete',
  'vehicles.delete',
]

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1'),
       ($1, 'Condominio', null) returning id`,
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', 3000) returning id`,
    [company.id],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, plate, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', null, 4500) returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    user,
    site: sites.rows[0]?.id ?? '',
    other: sites.rows[1]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    digger: vehicle.rows[0]?.id ?? '',
    base: `/api/companies/${company.slug}/daily-reports`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

function body(s: Scene, overrides: Record<string, unknown> = {}) {
  return {
    site_id: s.site,
    date: '2026-11-05',
    weather: 'Sereno',
    work_done: 'Getto del solaio',
    notes: null,
    labor: [
      { employee_id: s.verdi, hours: '8', description: null },
      { employee_id: s.bassi, hours: '7.5', description: 'Casseri' },
    ],
    vehicles: [{ vehicle_id: s.digger, hours: '3.25', description: null }],
    ...overrides,
  }
}

interface Report {
  id: string
  status: string
  total_labor_hours: string
  total_vehicle_hours: string
  labor: { employee_id: string; last_name: string; hours: string }[]
  vehicles: { vehicle_id: string; name: string; hours: string }[]
  created_by: { id: string; name: string } | null
  approved_by: { id: string } | null
}

async function create(s: Scene, overrides: Record<string, unknown> = {}) {
  const res = await s.browser.call('POST', s.base, { body: body(s, overrides) })
  expect(res.statusCode).toBe(201)
  return { report: res.json<Report>(), etag: String(res.headers.etag) }
}

describe('daily reports', () => {
  it('prints the report as a PDF to sign, with hours and no costs', async () => {
    const s = await scene()
    await ctx.owner.query(
      "update public.sites set code = 'C/1 \"x\"', address = 'Via Roma 1, Asti' where id = $1",
      [s.site],
    )
    await ctx.owner.query("update public.vehicles set plate = 'AB123CD' where id = $1", [s.digger])
    const { report } = await create(s, { notes: 'Consegna ferro alle 10' })
    const url = `${s.base}/${report.id}`
    const pdf = await s.browser.call('GET', `${url}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    // Quotes and slashes of the site code never reach the header.
    expect(pdf.headers['content-disposition']).toBe(
      'attachment; filename="rapportino-2026-11-05-C-1-x-.pdf"',
    )
    const text = pdf.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain('(Rapportino del 05/11/2026 \\(bozza, non ancora inviato\\))')
    expect(text).toContain('(Cantiere: C/1 "x" \x96 Villetta)')
    expect(text).toContain('(Via Roma 1, Asti)')
    expect(text).toContain('(Meteo: Sereno)')
    expect(text).toContain('(Getto del solaio)')
    expect(text).toContain('(Verdi Luca)')
    expect(text).toContain('(Casseri)')
    expect(text).toContain('(7,5)')
    expect(text).toContain('(15,5)')
    expect(text).toContain('(Escavatore \\(AB123CD\\))')
    expect(text).toContain('(3,25)')
    expect(text).toContain('(Consegna ferro alle 10)')
    expect(text).toContain('(Il capo cantiere)')
    // No costs: the hourly cost of an employee (28,00) is nowhere.
    expect(text).not.toContain('28,00')
    expect(text).not.toContain('\x80')

    // Approved: no more «bozza», and who approved it.
    for (const [status, version] of [
      ['submitted', '"1"'],
      ['approved', '"2"'],
    ] as const) {
      const moved = await s.browser.call('POST', `${url}/status`, {
        body: { status },
        headers: { 'If-Match': version },
      })
      expect(moved.statusCode).toBe(200)
    }
    const approved = (await s.browser.call('GET', `${url}/pdf`)).rawPayload.toString('latin1')
    expect(approved).toContain('(Rapportino del 05/11/2026)')
    expect(approved).toMatch(/\(Approvato da .+ il \d{2}\/\d{2}\/\d{4}\)/)

    // Another company, a wrong id, no permission: 404.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', `${theirs.base}/${report.id}/pdf`)).statusCode).toBe(
      404,
    )
    expect((await s.browser.call('GET', `${s.base}/x/pdf`)).statusCode).toBe(404)
    const guest = await fx.user()
    await fx.member(guest.id, s.company.id, await fx.role(s.company.id, 'Ospite', ['sites.view']))
    const browser = new Browser(ctx.app)
    await browser.signIn(guest.email)
    expect((await browser.call('GET', `${url}/pdf`)).statusCode).toBe(404)
  })

  it('exports the reports as CSV with the same filters', async () => {
    const s = await scene()
    await create(s)
    await create(s, {
      site_id: s.other,
      date: '2026-11-06',
      weather: null,
      work_done: '@scavo',
      labor: [],
      vehicles: [],
    })
    const url = `${s.base}/export`
    const res = await s.browser.call('GET', `${url}?sort=date`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="rapportini.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'Data;Cantiere;Codice cantiere;Stato;Ore manodopera;Ore mezzi;Meteo;Lavori eseguiti;Note;Compilato da;Approvato da',
    )
    expect(lines[1]).toMatch(
      /^05\/11\/2026;Villetta;C-1;Bozza;15,50;3,25;Sereno;Getto del solaio;;[^;]+;$/,
    )
    expect(lines[2]).toMatch(/^06\/11\/2026;Condominio;;Bozza;0,00;0,00;;'@scavo;;[^;]+;$/)
    const filtered = await s.browser.call('GET', `${url}?filter[site]=${s.site}`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?filter[status]=chiuso`)).statusCode).toBe(422)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('creates a draft with hours and totals, without costs, and reads it back', async () => {
    const s = await scene()
    const { report, etag } = await create(s)
    expect(etag).toBe('"1"')
    expect(report).toMatchObject({
      status: 'draft',
      date: '2026-11-05',
      site: { id: s.site, name: 'Villetta', code: 'C-1' },
      total_labor_hours: '15.50',
      total_vehicle_hours: '3.25',
      created_by: { id: s.user.id },
      approved_by: null,
      submitted_at: null,
    })
    expect(report.labor.map((l) => [l.last_name, l.hours])).toEqual([
      ['Verdi', '8.00'],
      ['Bassi', '7.50'],
    ])
    expect(report.vehicles).toEqual([
      { vehicle_id: s.digger, name: 'Escavatore', plate: null, hours: '3.25', description: null },
    ])
    expect(JSON.stringify(report)).not.toContain('cost')
    const read = await s.browser.call('GET', `${s.base}/${report.id}`)
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual(report)
  })

  it('one report per site and day; rows are validated under their path', async () => {
    const s = await scene()
    await create(s)
    const twice = await s.browser.call('POST', s.base, { body: body(s) })
    expect(twice.statusCode).toBe(422)
    expect(twice.json()).toMatchObject({ errors: { date: [expect.any(String)] } })

    const bad = await s.browser.call('POST', s.base, {
      body: body(s, {
        date: '2026-11-06',
        labor: [
          { employee_id: s.verdi, hours: '25', description: null },
          { employee_id: s.verdi, hours: '1', description: null },
          { employee_id: crypto.randomUUID(), hours: '0', description: null },
        ],
        vehicles: [{ vehicle_id: s.digger, hours: 'otto', description: null }],
      }),
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'labor.0.hours',
      'labor.1.employee_id',
      'labor.2.hours',
      'vehicles.0.hours',
    ])
    const unknown = await s.browser.call('POST', s.base, {
      body: body(s, {
        date: '2026-11-06',
        site_id: crypto.randomUUID(),
        labor: [{ employee_id: crypto.randomUUID(), hours: '1', description: null }],
      }),
    })
    expect(unknown.statusCode).toBe(422)
    expect(Object.keys(unknown.json<{ errors: object }>().errors).sort()).toEqual([
      'labor.0.employee_id',
      'site_id',
    ])
    const missing = await s.browser.call('POST', s.base, { body: { site_id: s.site } })
    expect(missing.statusCode).toBe(422)
  })

  it('updates a draft with If-Match, replacing the hours', async () => {
    const s = await scene()
    const { report, etag } = await create(s)
    const url = `${s.base}/${report.id}`
    const noVersion = await s.browser.call('PUT', url, { body: body(s) })
    expect(noVersion.statusCode).toBe(428)
    const res = await s.browser.call('PUT', url, {
      body: body(s, { labor: [{ employee_id: s.bassi, hours: '4', description: null }] }),
      headers: { 'If-Match': etag },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('"2"')
    expect(res.json<Report>().labor.map((l) => l.employee_id)).toEqual([s.bassi])
    expect(res.json<Report>().total_labor_hours).toBe('4.00')
    const stale = await s.browser.call('PUT', url, {
      body: body(s),
      headers: { 'If-Match': etag },
    })
    expect(stale.statusCode).toBe(412)
  })

  it('submits, approves and sends back; only drafts change or go away', async () => {
    const s = await scene()
    const { report } = await create(s)
    const url = `${s.base}/${report.id}`
    const move = (status: string, version: string) =>
      s.browser.call('POST', `${url}/status`, {
        body: { status },
        headers: { 'If-Match': version },
      })
    const approveDraft = await move('approved', '"1"')
    expect(approveDraft.statusCode).toBe(409)
    expect(approveDraft.json()).toMatchObject({ code: 'invalid_transition' })
    const submitted = await move('submitted', '"1"')
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json()).toMatchObject({
      status: 'submitted',
      submitted_at: expect.stringMatching(/T/) as string,
    })

    const edit = await s.browser.call('PUT', url, { body: body(s), headers: { 'If-Match': '"2"' } })
    expect(edit.statusCode).toBe(409)
    expect(edit.json()).toMatchObject({ code: 'report_not_draft' })
    const remove = await s.browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })
    expect(remove.statusCode).toBe(409)
    expect(remove.json()).toMatchObject({ code: 'report_not_draft' })

    const approved = await move('approved', '"2"')
    expect(approved.json()).toMatchObject({ status: 'approved', approved_by: { id: s.user.id } })
    const back = await move('draft', '"3"')
    expect(back.json()).toMatchObject({ status: 'draft', approved_by: null, submitted_at: null })
    expect((await move('nope', '"4"')).statusCode).toBe(422)

    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"3"' } })).statusCode,
    ).toBe(412)
    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"4"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('lists with filters and keeps referenced sites, employees and vehicles', async () => {
    const s = await scene()
    const { report } = await create(s)
    await create(s, { site_id: s.other, date: '2026-11-03', labor: [], vehicles: [] })
    type List = { data: { id: string; date: string }[]; meta: { total: number } }
    const all = await s.browser.call('GET', s.base)
    expect(all.json<List>().data.map((r) => r.date)).toEqual(['2026-11-05', '2026-11-03'])
    const bySite = await s.browser.call('GET', `${s.base}?filter[site]=${s.site}`)
    expect(bySite.json<List>().data.map((r) => r.id)).toEqual([report.id])
    const range = await s.browser.call(
      'GET',
      `${s.base}?filter[from]=2026-11-01&filter[to]=2026-11-04&filter[status]=draft&sort=date`,
    )
    expect(range.json<List>().meta.total).toBe(1)
    expect((await s.browser.call('GET', `${s.base}?filter[from]=ieri`)).statusCode).toBe(422)
    // By employee and by vehicle: only the reports with their hours.
    const third = await create(s, {
      site_id: s.other,
      date: '2026-11-04',
      labor: [{ employee_id: s.bassi, hours: '4', description: null }],
      vehicles: [],
    })
    const ids = async (query: string) =>
      (await s.browser.call('GET', `${s.base}?${query}&sort=date`))
        .json<List>()
        .data.map((r) => r.id)
    expect(await ids(`filter[employee]=${s.verdi}`)).toEqual([report.id])
    expect(await ids(`filter[employee]=${s.bassi}`)).toEqual([third.report.id, report.id])
    expect(await ids(`filter[vehicle]=${s.digger}`)).toEqual([report.id])
    expect(await ids(`filter[employee]=${s.bassi}&filter[site]=${s.other}`)).toEqual([
      third.report.id,
    ])
    const exported = await s.browser.call('GET', `${s.base}/export?filter[employee]=${s.bassi}`)
    expect(exported.body.trim().split('\r\n')).toHaveLength(3)
    // Another company's employee matches nothing here.
    const foreign = await scene()
    expect(await ids(`filter[employee]=${foreign.verdi}`)).toEqual([])
    for (const bad of ['filter[employee]=luca', 'filter[vehicle]=1']) {
      const res = await s.browser.call('GET', `${s.base}?${bad}`)
      expect(res.statusCode).toBe(422)
    }

    const del = (path: string) =>
      s.browser.call('DELETE', `/api/companies/${s.company.slug}/${path}`, {
        headers: { 'If-Match': '"1"' },
      })
    for (const path of [`sites/${s.site}`, `employees/${s.verdi}`, `vehicles/${s.digger}`]) {
      const res = await del(path)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'has_documents' })
    }
  })

  it('needs the reports permissions', async () => {
    const owner = await scene()
    const { report } = await create(owner)
    const url = `${owner.base}/${report.id}`
    const writer = await fx.user()
    const role = await fx.role(owner.company.id, 'Capo', ['reports.view', 'reports.update'])
    await fx.member(writer.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(writer.email)
    expect((await browser.call('GET', url)).statusCode).toBe(200)
    expect((await browser.call('POST', owner.base, { body: body(owner) })).statusCode).toBe(403)
    const move = (status: string, version: string) =>
      browser.call('POST', `${url}/status`, { body: { status }, headers: { 'If-Match': version } })
    expect((await move('submitted', '"1"')).statusCode).toBe(200)
    expect((await move('approved', '"2"')).statusCode).toBe(403)
    expect((await move('draft', '"2"')).statusCode).toBe(403)
    expect((await browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })).statusCode).toBe(
      403,
    )

    const nobody = await fx.user()
    const empty = await fx.role(owner.company.id, 'Nessuno', ['clients.view'])
    await fx.member(nobody.id, owner.company.id, empty)
    const outsider = new Browser(ctx.app)
    await outsider.signIn(nobody.email)
    expect((await outsider.call('GET', owner.base)).statusCode).toBe(403)
    expect((await outsider.call('GET', url)).statusCode).toBe(404)
    expect(
      (
        await outsider.call('POST', `${url}/status`, {
          body: { status: 'approved' },
          headers: { 'If-Match': '"2"' },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('today: proposes the team for a new report, or returns the existing one', async () => {
    const s = await scene(['reports.view'])
    await ctx.owner.query(
      'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
      [s.company.id, s.site, s.bassi],
    )
    await ctx.owner.query(
      `insert into public.employees (company_id, first_name, last_name, active)
       values ($1, 'Ex', 'Dipendente', false)`,
      [s.company.id],
    )
    const today = `${s.base}/today`
    type Today = {
      date: string
      report: Report | null
      proposal: { labor: { employee_id: string; hours: string }[]; date: string }
      employees: { id: string; last_name: string; in_team: boolean }[]
      vehicles: { id: string }[]
    }
    const res = await s.browser.call('GET', `${today}?site=${s.site}&date=2026-11-05`)
    expect(res.statusCode).toBe(200)
    const fresh = res.json<Today>()
    expect(fresh.report).toBeNull()
    expect(fresh.proposal).toMatchObject({ date: '2026-11-05', site_id: s.site, vehicles: [] })
    expect(fresh.proposal.labor).toEqual([
      { employee_id: s.bassi, hours: '8.00', description: null },
    ])
    expect(fresh.employees.map((e) => [e.last_name, e.in_team])).toEqual([
      ['Bassi', true],
      ['Verdi', false],
    ])
    expect(fresh.vehicles.map((v) => v.id)).toEqual([s.digger])
    expect(JSON.stringify(fresh)).not.toContain('cost')

    const writer = new Browser(ctx.app)
    const role = await fx.role(s.company.id, 'Scrive', ['reports.view', 'reports.create'])
    const author = await fx.user()
    await fx.member(author.id, s.company.id, role)
    await writer.signIn(author.email)
    const created = await writer.call('POST', s.base, { body: body(s) })
    expect(created.statusCode).toBe(201)
    const again = await s.browser.call('GET', `${today}?site=${s.site}&date=2026-11-05`)
    expect(again.json<Today>().report?.id).toBe(created.json<Report>().id)

    const now = await s.browser.call('GET', `${today}?site=${s.site}`)
    expect(now.json<Today>().date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await s.browser.call('GET', today)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${today}?site=${s.site}&date=ieri`)).statusCode).toBe(422)
    const foreign = await scene()
    expect((await s.browser.call('GET', `${today}?site=${foreign.site}`)).statusCode).toBe(404)
    expect(
      (
        await foreign.browser.call(
          'GET',
          `${s.base.replace(s.company.slug, foreign.company.slug)}/today?site=${s.site}`,
        )
      ).statusCode,
    ).toBe(404)
    const none = await scene(['clients.view'])
    expect(
      (await none.browser.call('GET', `${none.base}/today?site=${none.site}`)).statusCode,
    ).toBe(403)
  })
})
