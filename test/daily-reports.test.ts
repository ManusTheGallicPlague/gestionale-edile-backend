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
  'employees.view',
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

  it('exports the monthly hours of each employee, one column per day', async () => {
    const s = await scene()
    await ctx.owner.query(
      "update public.employees set tax_code = 'VRDLCU80A01H501U' where id = $1",
      [s.verdi],
    )
    // Verdi on two sites the same day: 8 + 2 hours on the 5th.
    const { report } = await create(s)
    await create(s, {
      site_id: s.other,
      labor: [{ employee_id: s.verdi, hours: '2', description: null }],
      vehicles: [],
    })
    await create(s, {
      date: '2026-11-30',
      labor: [{ employee_id: s.bassi, hours: '4.25', description: null }],
      vehicles: [],
    })
    // Outside the month.
    await create(s, {
      date: '2026-12-01',
      labor: [{ employee_id: s.verdi, hours: '9', description: null }],
    })
    await create(s, {
      date: '2026-10-31',
      labor: [{ employee_id: s.verdi, hours: '9', description: null }],
    })

    const url = `${s.base}/monthly-hours`
    const read = async (query: string) => {
      const res = await s.browser.call('GET', `${url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.body.replace('﻿', '').trim().split('\r\n')
    }
    const res = await s.browser.call('GET', `${url}?month=2026-11`)
    expect(res.headers['content-disposition']).toBe('attachment; filename="ore-2026-11.csv"')
    const lines = await read('month=2026-11')
    const days = Array.from({ length: 30 }, (_, i) => String(i + 1))
    expect(lines[0]).toBe(
      [
        'Cognome',
        'Nome',
        'Codice fiscale',
        ...days,
        'Totale',
        'Di cui straordinario',
        'Giorni di trasferta',
        'Di cui festive',
        'Ore perse per maltempo',
      ].join(';'),
    )
    const row = (
      last: string,
      first: string,
      tax: string,
      cells: Record<number, string>,
      total: string,
      overtime = '0',
    ) =>
      [
        last,
        first,
        tax,
        ...days.map((d) => cells[Number(d)] ?? ''),
        total,
        overtime,
        '0',
        '0',
        '0',
      ].join(';')
    expect(lines.slice(1)).toEqual([
      row('Bassi', 'Anna', '', { 5: '7,5', 30: '4,25' }, '11,75'),
      row('Verdi', 'Luca', 'VRDLCU80A01H501U', { 5: '10' }, '10'),
    ])
    // February has 28 days; a month with no reports has only the header.
    const feb = await read('month=2026-02')
    expect(feb).toHaveLength(1)
    expect(feb[0]?.split(';')).toHaveLength(3 + 28 + 5)

    // Only one site, only one status.
    expect((await read(`month=2026-11&filter[site]=${s.other}`)).slice(1)).toEqual([
      row('Verdi', 'Luca', 'VRDLCU80A01H501U', { 5: '2' }, '2'),
    ])
    expect(await read('month=2026-11&filter[status]=approved')).toHaveLength(1)
    for (const [status, version] of [
      ['submitted', '"1"'],
      ['approved', '"2"'],
    ] as const) {
      const moved = await s.browser.call('POST', `${s.base}/${report.id}/status`, {
        body: { status },
        headers: { 'If-Match': version },
      })
      expect(moved.statusCode).toBe(200)
    }
    expect((await read('month=2026-11&filter[status]=approved')).slice(1)).toEqual([
      row('Bassi', 'Anna', '', { 5: '7,5' }, '7,5'),
      row('Verdi', 'Luca', 'VRDLCU80A01H501U', { 5: '8' }, '8'),
    ])

    // A missing or wrong month, a wrong filter: 422 under the field.
    for (const [query, field] of [
      ['', 'month'],
      ['month=2026-13', 'month'],
      ['month=2026-11-01', 'month'],
      ['month=2026-11&filter[status]=nope', 'filter[status]'],
      ['month=2026-11&filter[site]=x', 'filter[site]'],
    ] as const) {
      const bad = await s.browser.call('GET', `${url}?${query}`)
      expect(bad.statusCode).toBe(422)
      expect(bad.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty([field])
    }

    // Another company sees only its own hours; its slug for ours is a 404.
    const theirs = await scene()
    const other = await theirs.browser.call('GET', `${theirs.base}/monthly-hours?month=2026-11`)
    expect(other.body.replace('﻿', '').trim().split('\r\n')).toHaveLength(1)
    expect((await theirs.browser.call('GET', `${url}?month=2026-11`)).statusCode).toBe(404)

    // Both permissions are needed: hours alone do not show tax codes.
    for (const permissions of [['reports.view'], ['employees.view']] as Permission[][]) {
      const guest = await fx.user()
      await fx.member(
        guest.id,
        s.company.id,
        await fx.role(s.company.id, `Ospite ${permissions.join()}`, permissions),
      )
      const browser = new Browser(ctx.app)
      await browser.signIn(guest.email)
      expect((await browser.call('GET', `${url}?month=2026-11`)).statusCode).toBe(403)
    }
  })

  it('prints the work log of a site for a period, one report per page', async () => {
    const s = await scene()
    await create(s, { work_done: 'Scavo di fondazione' })
    await create(s, { date: '2026-11-03', work_done: 'Tracciamento' })
    await create(s, { date: '2026-11-20', work_done: 'Fuori periodo' })
    await create(s, { site_id: s.other, work_done: 'Altro cantiere' })

    const url = `${s.base}/pdf`
    const query = `filter[site]=${s.site}&filter[from]=2026-11-01&filter[to]=2026-11-10`
    const pdf = await s.browser.call('GET', `${url}?${query}`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toBe(
      'attachment; filename="giornale-lavori-C-1-2026-11-01-2026-11-10.pdf"',
    )
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('(Tracciamento)')
    expect(text).toContain('(Scavo di fondazione)')
    expect(text).not.toContain('Fuori periodo')
    expect(text).not.toContain('Altro cantiere')
    // In date order, each on its own page.
    expect(text.indexOf('(Tracciamento)')).toBeLessThan(text.indexOf('(Scavo di fondazione)'))
    expect(text).toContain('(Rapportino del 03/11/2026 \x96 pagina 1 di 2)')
    expect(text).toContain('(Rapportino del 05/11/2026 \x96 pagina 2 di 2)')

    // Only approved reports: none in the period.
    const none = await s.browser.call('GET', `${url}?${query}&filter[status]=approved`)
    expect(none.statusCode).toBe(422)
    expect(none.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty(['filter[from]'])

    // Site and period are required.
    const missing = await s.browser.call('GET', `${url}?filter[site]=${s.site}`)
    expect(missing.statusCode).toBe(422)
    expect(Object.keys(missing.json<{ errors: object }>().errors).sort()).toEqual([
      'filter[from]',
      'filter[to]',
    ])

    // More than 200 reports: shorten the period.
    await ctx.owner.query(
      `insert into public.daily_reports (company_id, site_id, report_date)
       select $1, $2, d::date from generate_series('2025-01-01'::date, '2025-07-20', '1 day') d`,
      [s.company.id, s.site],
    )
    const long = `filter[site]=${s.site}&filter[from]=2025-01-01&filter[to]=2025-12-31`
    const tooMany = await s.browser.call('GET', `${url}?${long}`)
    expect(tooMany.statusCode).toBe(422)
    expect(tooMany.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty([
      'filter[to]',
    ])

    // Another company: our site is a 404 for them, our slug a 404 too.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', `${theirs.base}/pdf?${query}`)).statusCode).toBe(404)
    expect((await theirs.browser.call('GET', `${url}?${query}`)).statusCode).toBe(404)
    // Without reports.view: 403.
    const guest = await fx.user()
    await fx.member(guest.id, s.company.id, await fx.role(s.company.id, 'Ospite', ['sites.view']))
    const browser = new Browser(ctx.app)
    await browser.signIn(guest.email)
    expect((await browser.call('GET', `${url}?${query}`)).statusCode).toBe(403)
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
      'Data;Cantiere;Codice cantiere;Stato;Ore manodopera;Ore mezzi;Meteo;Lavori eseguiti;Note;Compilato da;Approvato da;Ore straordinario;Ore perse per maltempo',
    )
    expect(lines[1]).toMatch(
      /^05\/11\/2026;Villetta;C-1;Bozza;15,50;3,25;Sereno;Getto del solaio;;[^;]+;;0,00;0,00$/,
    )
    expect(lines[2]).toMatch(
      /^06\/11\/2026;Condominio;;Bozza;0,00;0,00;;'@scavo;;[^;]+;;0,00;0,00$/,
    )
    const filtered = await s.browser.call('GET', `${url}?filter[site]=${s.site}`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?filter[status]=chiuso`)).statusCode).toBe(422)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('searches the work done and the notes with filter[q], also in the CSV', async () => {
    const s = await scene()
    await create(s, { work_done: 'Getto del SOLAIO', notes: null })
    await create(s, { date: '2026-11-06', work_done: null, notes: 'Solaio da bagnare' })
    await create(s, { date: '2026-11-07', work_done: 'Scavo', notes: null })
    const stranger = await scene()
    await create(stranger)

    type List = { data: { date: string }[]; meta: { total: number } }
    const list = async (q: string) =>
      (await s.browser.call('GET', `${s.base}?filter[q]=${q}&sort=date`)).json<List>()
    expect((await list('%20solaio%20')).data.map((r) => r.date)).toEqual([
      '2026-11-05',
      '2026-11-06',
    ])
    expect((await list('bagnare')).data.map((r) => r.date)).toEqual(['2026-11-06'])
    expect((await list('%25')).meta.total).toBe(0)
    expect((await list('%20')).meta.total).toBe(3)

    const csv = await s.browser.call('GET', `${s.base}/export?filter[q]=scavo`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^07\/11\/2026;Villetta;/)

    for (const path of [s.base, `${s.base}/export`]) {
      const long = await s.browser.call('GET', `${path}?filter[q]=${'a'.repeat(101)}`)
      expect(long.statusCode).toBe(422)
      expect(long.json()).toMatchObject({ errors: { 'filter[q]': ['Al massimo 100 caratteri.'] } })
      const twice = await s.browser.call('GET', `${path}?filter[q]=a&filter[q]=b`)
      expect(twice.statusCode).toBe(422)
      expect(twice.json()).toMatchObject({ errors: { 'filter[q]': ['Indicalo una volta sola.'] } })
    }
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
      {
        employee_id: s.bassi,
        hours: '8.00',
        overtime_hours: '0.00',
        travel: false,
        description: null,
      },
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

describe('daily report like the previous one', () => {
  type Proposal = {
    labor: { employee_id: string; hours: string; description: string | null }[]
    vehicles: { vehicle_id: string; hours: string; description: string | null }[]
    weather: string | null
    work_done: string | null
  }

  it('proposes people, vehicles and hours of the last earlier report of the site', async () => {
    const s = await scene()
    const today = (query: string) =>
      s.browser.call('GET', `${s.base}/today?site=${s.site}&${query}`)

    // No earlier report: the usual team proposal (here an empty team).
    const none = await today('date=2026-11-05&copy_previous=true')
    expect(none.statusCode).toBe(200)
    expect(none.json<{ proposal: Proposal }>().proposal).toMatchObject({ labor: [], vehicles: [] })

    await create(s, { date: '2026-11-03', work_done: 'Scavo' })
    await create(s, {
      date: '2026-11-04',
      labor: [
        { employee_id: s.verdi, hours: '6', description: 'Ferri' },
        { employee_id: s.bassi, hours: '7.5', description: null },
      ],
      vehicles: [{ vehicle_id: s.digger, hours: '2', description: 'Scavo a sezione' }],
    })
    // A later report and one of another site are ignored.
    await create(s, { date: '2026-11-06' })
    await create(s, { site_id: s.other, date: '2026-11-04', vehicles: [] })

    const res = await today('date=2026-11-05&copy_previous=true')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ proposal: Proposal }>().proposal).toMatchObject({
      weather: null,
      work_done: null,
      labor: [
        { employee_id: s.bassi, hours: '7.50', description: null },
        { employee_id: s.verdi, hours: '6.00', description: 'Ferri' },
      ],
      vehicles: [{ vehicle_id: s.digger, hours: '2.00', description: 'Scavo a sezione' }],
    })

    // People and vehicles no longer active stay out.
    await ctx.owner.query('update public.employees set active = false where id = $1', [s.verdi])
    await ctx.owner.query('update public.vehicles set active = false where id = $1', [s.digger])
    const after = (await today('date=2026-11-05&copy_previous=true')).json<{ proposal: Proposal }>()
    expect(after.proposal.labor.map((l) => l.employee_id)).toEqual([s.bassi])
    expect(after.proposal.vehicles).toEqual([])

    // Without the flag nothing changes.
    const plain = await today('date=2026-11-05&copy_previous=false')
    expect(plain.json<{ proposal: Proposal }>().proposal.vehicles).toEqual([])
    const bad = await today('date=2026-11-05&copy_previous=si')
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ errors: { copy_previous: ['Indica true o false.'] } })
  })
})

describe('daily reports and absences', () => {
  async function away(
    s: Scene,
    employee: string,
    kind: string,
    from: string,
    to: string,
    hours: string | null = null,
  ) {
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours)
       values ($1, $2, $3, $4, $5, $6)`,
      [s.company.id, employee, kind, from, to, hours],
    )
  }

  it('refuses hours of someone away the whole day, not of a leave of a few hours', async () => {
    const s = await scene()
    await away(s, s.verdi, 'vacation', '2026-11-03', '2026-11-05')
    await away(s, s.bassi, 'leave', '2026-11-05', '2026-11-05', '2')

    for (const date of ['2026-11-03', '2026-11-05']) {
      const res = await s.browser.call('POST', s.base, { body: body(s, { date }) })
      expect(res.statusCode).toBe(422)
      const errors = res.json<{ errors: Record<string, string[]> }>().errors
      expect(Object.keys(errors)).toEqual(['labor.0.employee_id'])
      // The kind of the absence is not told to who writes the report.
      expect(errors['labor.0.employee_id']?.[0]).not.toMatch(/ferie|malattia/i)
    }
    // Only Bassi, on leave for two hours: accepted. The vehicles do not matter.
    const leave = await s.browser.call('POST', s.base, {
      body: body(s, { labor: [{ employee_id: s.bassi, hours: '6', description: null }] }),
    })
    expect(leave.statusCode).toBe(201)

    // The day after the holiday Verdi works again; moving the report back is refused.
    const { report, etag } = await create(s, { date: '2026-11-06', site_id: s.other })
    const moved = await s.browser.call('PUT', `${s.base}/${report.id}`, {
      body: body(s, { date: '2026-11-04', site_id: s.other }),
      headers: { 'if-match': etag },
    })
    expect(moved.statusCode).toBe(422)
    expect(Object.keys(moved.json<{ errors: object }>().errors)).toEqual(['labor.0.employee_id'])
    const kept = await s.browser.call('GET', `${s.base}/${report.id}`)
    expect(kept.json()).toMatchObject({ date: '2026-11-06' })
    expect(kept.headers.etag).toBe(etag)

    // A sick leave of an employee with the same name in another company does not count.
    const foreign = await scene()
    await away(foreign, foreign.verdi, 'sick_leave', '2026-11-01', '2026-11-30')
    expect(
      (await s.browser.call('POST', s.base, { body: body(s, { date: '2026-11-07' }) })).statusCode,
    ).toBe(201)
  })

  it('today: leaves out of the proposal who is away the whole day, and says why', async () => {
    const s = await scene()
    for (const employee of [s.verdi, s.bassi]) {
      await ctx.owner.query(
        'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
        [s.company.id, s.site, employee],
      )
    }
    await away(s, s.verdi, 'sick_leave', '2026-11-09', '2026-11-10')
    await away(s, s.bassi, 'leave', '2026-11-10', '2026-11-10', '2.5')
    type Today = {
      proposal: { labor: { employee_id: string }[] }
      employees: {
        id: string
        away: boolean
        absence: string | null
        absence_hours: string | null
      }[]
    }
    const today = async (query: string) => {
      const res = await s.browser.call('GET', `${s.base}/today?site=${s.site}&${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<Today>()
    }
    const sick = await today('date=2026-11-10')
    expect(sick.proposal.labor.map((l) => l.employee_id)).toEqual([s.bassi])
    expect(sick.employees.map((e) => [e.id, e.away, e.absence, e.absence_hours])).toEqual([
      [s.bassi, false, 'leave', '2.50'],
      [s.verdi, true, 'sick_leave', null],
    ])

    // Without employees.view the capo cantiere knows who is away, not why.
    const chief = new Browser(ctx.app)
    const role = await fx.role(s.company.id, 'Capo cantiere', ['reports.view'])
    const person = await fx.user()
    await fx.member(person.id, s.company.id, role)
    await chief.signIn(person.email)
    const seen = await chief.call('GET', `${s.base}/today?site=${s.site}&date=2026-11-10`)
    expect(seen.statusCode).toBe(200)
    expect(seen.json<Today>().proposal.labor.map((l) => l.employee_id)).toEqual([s.bassi])
    expect(seen.json<Today>().employees.map((e) => [e.away, e.absence, e.absence_hours])).toEqual([
      [false, null, null],
      [true, null, null],
    ])
    expect(seen.body).not.toContain('sick_leave')

    // «Come ieri» also leaves Verdi out, while he is sick.
    await create(s, { date: '2026-11-08' })
    const copied = await today('date=2026-11-09&copy_previous=true')
    expect(copied.proposal.labor.map((l) => l.employee_id)).toEqual([s.bassi])

    const back = await today('date=2026-11-11')
    expect(back.proposal.labor.map((l) => l.employee_id).sort()).toEqual([s.verdi, s.bassi].sort())
    expect(back.employees.every((e) => !e.away && e.absence === null)).toBe(true)
  })
})

describe('daily report of the day and expired documents', () => {
  it('tells who has an expired document on that day, not which one, and does not block', async () => {
    const s = await scene()
    // Verdi: medical check expired on 2026-11-09. Bassi: an old course expired, the refresher
    // is on file, and first aid expires on 2026-11-10 (still valid that day).
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on, notes)
       values ($1, $2, 'medical_check', '2026-11-09', 'n. 81'),
              ($1, $3, 'safety_training', '2026-10-01', null),
              ($1, $3, 'safety_training', '2027-10-01', null),
              ($1, $3, 'first_aid', '2026-11-10', null)`,
      [s.company.id, s.verdi, s.bassi],
    )
    await ctx.owner.query(
      `insert into public.vehicle_documents (company_id, vehicle_id, kind, expires_on, notes)
       values ($1, $2, 'insurance', '2026-11-09', 'polizza 7')`,
      [s.company.id, s.digger],
    )
    type Today = {
      employees: { id: string; documents_expired: boolean }[]
      vehicles: { id: string; documents_expired: boolean }[]
    }
    const flags = (t: Today) => ({
      employees: Object.fromEntries(t.employees.map((e) => [e.id, e.documents_expired])),
      vehicles: Object.fromEntries(t.vehicles.map((v) => [v.id, v.documents_expired])),
    })

    // A capo cantiere with only reports.view sees the warning, not the document.
    const chief = new Browser(ctx.app)
    const role = await fx.role(s.company.id, 'Capo cantiere', ['reports.view', 'reports.create'])
    const person = await fx.user()
    await fx.member(person.id, s.company.id, role)
    await chief.signIn(person.email)
    const on = async (date: string) => {
      const res = await chief.call('GET', `${s.base}/today?site=${s.site}&date=${date}`)
      expect(res.statusCode).toBe(200)
      return res
    }
    const expired = await on('2026-11-10')
    expect(flags(expired.json<Today>())).toMatchObject({
      employees: { [s.verdi]: true, [s.bassi]: false },
      vehicles: { [s.digger]: true },
    })
    for (const hidden of ['medical_check', 'insurance', 'n. 81', 'polizza 7']) {
      expect(expired.body).not.toContain(hidden)
    }
    // The day the documents were still valid, nothing to warn.
    expect(flags((await on('2026-11-09')).json<Today>())).toMatchObject({
      employees: { [s.verdi]: false, [s.bassi]: false },
      vehicles: { [s.digger]: false },
    })

    // A warning, not a block: the hours of Verdi and the digger are accepted.
    const saved = await chief.call('POST', s.base, { body: body(s, { date: '2026-11-10' }) })
    expect(saved.statusCode).toBe(201)

    // Renewing the medical check clears the warning.
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       values ($1, $2, 'medical_check', '2027-11-09')`,
      [s.company.id, s.verdi],
    )
    expect(flags((await on('2026-11-10')).json<Today>()).employees[s.verdi]).toBe(false)

    // Documents of another company never reach this one.
    const other = await scene()
    const theirs = await other.browser.call(
      'GET',
      `${other.base}/today?site=${other.site}&date=2026-11-10`,
    )
    const t = theirs.json<Today>()
    expect([...t.employees, ...t.vehicles].every((x) => !x.documents_expired)).toBe(true)
  })
})
