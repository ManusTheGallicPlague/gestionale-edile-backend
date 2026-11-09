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

const ALL: Permission[] = ['reports.view', 'employees.view', 'vehicles.view']

interface Summary {
  hours: string
  days: number
  cost: string | null
  sites: {
    site: { id: string; name: string; code: string | null }
    hours: string
    days: number
    cost: string | null
    first_date: string
    last_date: string
  }[]
}

/** A company with two sites, two employees (one without hourly cost) and a vehicle. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows.map((r) => r.id)
  const [villa = '', condo = ''] = await one(
    `insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1'),
       ($1, 'Condominio', null) returning id`,
  )
  const [verdi = '', bassi = ''] = await one(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2850), ($1, 'Anna', 'Bassi', null) returning id`,
  )
  const [digger = ''] = await one(
    `insert into public.vehicles (company_id, name, kind, plate, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', null, 4500) returning id`,
  )
  /** A daily report with hours of Verdi, Bassi and the digger (0 = none). */
  const report = async (
    site: string,
    date: string,
    status: string,
    hours: { verdi?: string; bassi?: string; digger?: string },
  ) => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status)
       values ($1, $2, $3, $4) returning id`,
      [company.id, site, date, status],
    )
    const id = rows[0]?.id ?? ''
    let position = 0
    for (const [employee, h] of [
      [verdi, hours.verdi],
      [bassi, hours.bassi],
    ] as const) {
      if (!h) continue
      await ctx.owner.query(
        `insert into public.daily_report_labor
           (company_id, report_id, employee_id, hours, position) values ($1, $2, $3, $4, $5)`,
        [company.id, id, employee, h, position++],
      )
    }
    if (hours.digger) {
      await ctx.owner.query(
        `insert into public.daily_report_vehicles
           (company_id, report_id, vehicle_id, hours, position) values ($1, $2, $3, $4, 0)`,
        [company.id, id, digger, hours.digger],
      )
    }
  }
  return { browser, company, villa, condo, verdi, bassi, digger, report, slug: company.slug }
}

const employeeUrl = (slug: string, id: string, query = '') =>
  `/api/companies/${slug}/employees/${id}/work-summary${query}`
const vehicleUrl = (slug: string, id: string, query = '') =>
  `/api/companies/${slug}/vehicles/${id}/work-summary${query}`

describe('ore di dipendenti e mezzi per cantiere', () => {
  it('somma ore, giorni e costo per cantiere, dal cantiere con più ore', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', digger: '3.5' })
    await s.report(s.villa, '2026-10-02', 'submitted', { verdi: '7.5' })
    await s.report(s.condo, '2026-10-02', 'draft', { verdi: '1', bassi: '8' })
    await s.report(s.condo, '2026-09-30', 'approved', { verdi: '0.33' })
    await s.report(s.condo, '2026-10-05', 'approved', { verdi: '10', digger: '2' })

    const res = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(res.statusCode).toBe(200)
    const body = res.json<Summary>()
    // 26.83 hours × 28.50 = 764.655; rounded per report line: 228 + 213.75 + 28.50 + 9.41 + 285
    expect(body).toEqual({
      hours: '26.83',
      days: 4,
      cost: '764.66',
      absences: { days: 0, hours: '0.00', kinds: [] },
      sites: [
        {
          site: { id: s.villa, name: 'Villetta', code: 'C-1' },
          hours: '15.50',
          days: 2,
          cost: '441.75',
          first_date: '2026-10-01',
          last_date: '2026-10-02',
        },
        {
          site: { id: s.condo, name: 'Condominio', code: null },
          hours: '11.33',
          days: 3,
          cost: '322.91',
          first_date: '2026-09-30',
          last_date: '2026-10-05',
        },
      ],
    })

    const vehicle = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(vehicle.statusCode).toBe(200)
    expect(vehicle.json<Summary>()).toMatchObject({
      hours: '5.50',
      days: 2,
      cost: '247.50',
      sites: [
        { site: { id: s.villa }, hours: '3.50', cost: '157.50' },
        { site: { id: s.condo }, hours: '2.00', cost: '90.00' },
      ],
    })
  })

  it('filtra per periodo e stato, con estremi compresi', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8' })
    await s.report(s.villa, '2026-10-31', 'draft', { verdi: '4' })
    await s.report(s.condo, '2026-11-01', 'approved', { verdi: '6' })

    const october = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[from]=2026-10-01&filter[to]=2026-10-31'),
    )
    expect(october.json<Summary>()).toMatchObject({ hours: '12.00', days: 2, cost: '342.00' })
    expect(october.json<Summary>().sites).toHaveLength(1)

    const approved = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[status]=approved'),
    )
    expect(approved.json<Summary>()).toMatchObject({ hours: '14.00', days: 2 })
    expect(approved.json<Summary>().sites.map((x) => x.site.id)).toEqual([s.villa, s.condo])
  })

  it('senza costo orario il costo è null; senza ore risponde a zero', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { bassi: '8' })
    const res = await s.browser.call('GET', employeeUrl(s.slug, s.bassi))
    expect(res.json<Summary>()).toMatchObject({
      hours: '8.00',
      cost: null,
      sites: [{ hours: '8.00', cost: null }],
    })

    const nothing = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[from]=2027-01-01'),
    )
    expect(nothing.json<Summary>()).toEqual({
      hours: '0.00',
      days: 0,
      cost: '0.00',
      sites: [],
      absences: { days: 0, hours: '0.00', kinds: [] },
    })
  })

  it('conta le assenze del dipendente nel periodo, per tipo, solo dentro le date', async () => {
    const s = await scene()
    const other = await scene()
    const absence = (
      company: string,
      employee: string,
      kind: string,
      starts: string,
      ends: string,
      hours: string | null = null,
    ) =>
      ctx.owner.query(
        `insert into public.employee_absences
           (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
         values ($1, $2, $3, $4, $5, $6, 'x')`,
        [company, employee, kind, starts, ends, hours],
      )
    await absence(s.company.id, s.verdi, 'vacation', '2026-10-26', '2026-11-06')
    await absence(s.company.id, s.verdi, 'sick_leave', '2026-11-16', '2026-11-17')
    await absence(s.company.id, s.verdi, 'leave', '2026-11-20', '2026-11-20', '2.5')
    await absence(s.company.id, s.verdi, 'leave', '2026-11-30', '2026-11-30', '1.25')
    await absence(s.company.id, s.verdi, 'vacation', '2026-12-28', '2027-01-04')
    // Absences of another employee and of another company do not count.
    await absence(s.company.id, s.bassi, 'injury', '2026-11-02', '2026-11-30')
    await absence(other.company.id, other.verdi, 'injury', '2026-11-02', '2026-11-30')
    await s.report(s.villa, '2026-11-10', 'draft', { verdi: '8' })

    type WithAbsences = Summary & {
      absences: {
        days: number
        hours: string
        kinds: { kind: string; days: number; hours: string }[]
      }
    }
    const of = async (query: string) => {
      const res = await s.browser.call('GET', employeeUrl(s.slug, s.verdi, query))
      expect(res.statusCode).toBe(200)
      return res.json<WithAbsences>().absences
    }
    // November: the holidays across October count only their 6 days inside.
    expect(await of('?filter[from]=2026-11-01&filter[to]=2026-11-30')).toEqual({
      days: 8,
      hours: '3.75',
      kinds: [
        { kind: 'vacation', days: 6, hours: '0.00' },
        { kind: 'sick_leave', days: 2, hours: '0.00' },
        { kind: 'leave', days: 0, hours: '3.75' },
      ],
    })
    // The status of the reports does not filter the absences.
    expect(
      (await of('?filter[from]=2026-11-01&filter[to]=2026-11-30&filter[status]=approved')).days,
    ).toBe(8)
    // Without dates, every absence; open on one side.
    expect((await of('')).days).toBe(12 + 2 + 8)
    expect((await of('?filter[from]=2026-12-31')).kinds).toEqual([
      { kind: 'vacation', days: 5, hours: '0.00' },
    ])
    expect((await of('?filter[to]=2026-10-31')).days).toBe(6)

    // Vehicles have no absences.
    const vehicle = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(vehicle.json<object>()).not.toHaveProperty('absences')
  })

  it('somma le manutenzioni del mezzo nel periodo, senza quelle di altri mezzi', async () => {
    const s = await scene()
    const job = (vehicle: string, date: string, cents: number | null) =>
      ctx.owner.query(
        `insert into public.vehicle_maintenances
           (company_id, vehicle_id, performed_on, kind, description, amount_cents)
         values ($1, $2, $3, 'repair', 'Riparazione', $4)`,
        [s.company.id, vehicle, date, cents],
      )
    // No reports and no maintenance: zero.
    const empty = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(empty.json<object>()).toMatchObject({ maintenance: { count: 0, amount: '0.00' } })

    await job(s.digger, '2026-09-30', 12010)
    await job(s.digger, '2026-10-15', 5)
    await job(s.digger, '2026-10-31', null)
    const [truck = ''] = (
      await ctx.owner.query<{ id: string }>(
        `insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle')
         returning id`,
        [s.company.id],
      )
    ).rows.map((r) => r.id)
    await job(truck, '2026-10-15', 99900)
    // Another company's vehicle with maintenance: never counted.
    const other = await scene()
    await ctx.owner.query(
      `insert into public.vehicle_maintenances
         (company_id, vehicle_id, performed_on, kind, description, amount_cents)
       values ($1, $2, '2026-10-15', 'repair', 'Loro', 70000)`,
      [other.company.id, other.digger],
    )

    const all = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(all.statusCode).toBe(200)
    expect(all.json<object>()).toMatchObject({ maintenance: { count: 3, amount: '120.15' } })
    const october = await s.browser.call(
      'GET',
      vehicleUrl(s.slug, s.digger, '?filter[from]=2026-10-01&filter[to]=2026-10-31'),
    )
    expect(october.json<object>()).toMatchObject({ maintenance: { count: 2, amount: '0.05' } })
    // The status of the reports does not filter the maintenance.
    const approved = await s.browser.call(
      'GET',
      vehicleUrl(s.slug, s.digger, '?filter[status]=approved'),
    )
    expect(approved.json<object>()).toMatchObject({ maintenance: { count: 3 } })
    // Employees have no maintenance.
    const employee = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(employee.json<object>()).not.toHaveProperty('maintenance')
  })

  it('somma i rifornimenti del mezzo nel periodo, senza quelli di altri mezzi', async () => {
    const s = await scene()
    const fill = (company: string, vehicle: string, date: string, liters: string, cents: number) =>
      ctx.owner.query(
        `insert into public.vehicle_refuelings
           (company_id, vehicle_id, refueled_on, liters, amount_cents)
         values ($1, $2, $3, $4, $5)`,
        [company, vehicle, date, liters, cents],
      )
    const empty = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(empty.json<object>()).toMatchObject({
      fuel: { count: 0, liters: '0.00', amount: '0.00' },
    })

    // 0.1 + 0.2: summed as numerics, never as floats.
    await fill(s.company.id, s.digger, '2026-09-30', '60.5', 11000)
    await fill(s.company.id, s.digger, '2026-10-01', '0.1', 10)
    await fill(s.company.id, s.digger, '2026-10-31', '0.2', 20)
    const [truck = ''] = (
      await ctx.owner.query<{ id: string }>(
        `insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle')
         returning id`,
        [s.company.id],
      )
    ).rows.map((r) => r.id)
    await fill(s.company.id, truck, '2026-10-15', '40', 7000)
    const other = await scene()
    await fill(other.company.id, other.digger, '2026-10-15', '80', 15000)

    const all = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(all.statusCode).toBe(200)
    expect(all.json<object>()).toMatchObject({
      fuel: { count: 3, liters: '60.80', amount: '110.30' },
    })
    const october = await s.browser.call(
      'GET',
      vehicleUrl(s.slug, s.digger, '?filter[from]=2026-10-01&filter[to]=2026-10-31'),
    )
    expect(october.json<object>()).toMatchObject({
      fuel: { count: 2, liters: '0.30', amount: '0.30' },
    })
    const approved = await s.browser.call(
      'GET',
      vehicleUrl(s.slug, s.digger, '?filter[status]=approved'),
    )
    expect(approved.json<object>()).toMatchObject({ fuel: { count: 3 } })
    const employee = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(employee.json<object>()).not.toHaveProperty('fuel')
  })

  it('calcola il consumo medio da pieno a pieno: litri all’ora o ogni 100 km', async () => {
    const s = await scene()
    const fill = (vehicle: string, date: string, liters: string, meter: number | null) =>
      ctx.owner.query(
        `insert into public.vehicle_refuelings
           (company_id, vehicle_id, refueled_on, liters, amount_cents, meter_reading)
         values ($1, $2, $3, $4, 1000, $5)`,
        [s.company.id, vehicle, date, liters, meter],
      )
    const fuel = async (id: string, query = '') =>
      (await s.browser.call('GET', vehicleUrl(s.slug, id, query))).json<{
        fuel: { meter_distance: number | null; consumption: string | null }
      }>().fuel
    // No readings, then just one: nothing to divide.
    await fill(s.digger, '2026-10-01', '50', null)
    expect(await fuel(s.digger)).toMatchObject({ meter_distance: null, consumption: null })
    await fill(s.digger, '2026-10-02', '40', 1000)
    expect(await fuel(s.digger)).toMatchObject({ meter_distance: null, consumption: null })
    // Same reading twice: zero hours, no consumption.
    await fill(s.digger, '2026-10-03', '10', 1000)
    expect(await fuel(s.digger)).toMatchObject({ meter_distance: 0, consumption: null })
    // A machine: the first fill only marks the start; 10 + 0.1 + 0.2 litres over 30 hours.
    // Registered out of order: the reading decides, not the date.
    await fill(s.digger, '2026-10-20', '0.2', 1030)
    await fill(s.digger, '2026-10-10', '0.1', 1020)
    expect(await fuel(s.digger)).toMatchObject({ meter_distance: 30, consumption: '0.34' })
    // Only October 3 to 31: from 1000 to 1030, 0.3 litres over 30 hours.
    expect(await fuel(s.digger, '?filter[from]=2026-10-03&filter[to]=2026-10-31')).toMatchObject({
      meter_distance: 30,
      consumption: '0.01',
    })

    // A road vehicle: litres per 100 km.
    const [truck = ''] = (
      await ctx.owner.query<{ id: string }>(
        `insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle')
         returning id`,
        [s.company.id],
      )
    ).rows.map((r) => r.id)
    await fill(truck, '2026-10-01', '60', 90000)
    await fill(truck, '2026-10-15', '35.5', 90400)
    await fill(truck, '2026-10-30', '34.5', 90800)
    expect(await fuel(truck)).toMatchObject({ meter_distance: 800, consumption: '8.75' })
    // The digger keeps its own.
    expect(await fuel(s.digger)).toMatchObject({ meter_distance: 30, consumption: '0.34' })
  })

  it('rifiuta filtri non validi con 422', async () => {
    const s = await scene()
    const res = await s.browser.call(
      'GET',
      employeeUrl(
        s.slug,
        s.verdi,
        '?filter[from]=2026-11-10&filter[to]=2026-11-01&filter[status]=boh',
      ),
    )
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors).sort()).toEqual([
      'filter[status]',
      'filter[to]',
    ])
    const bad = await s.browser.call('GET', vehicleUrl(s.slug, s.digger, '?filter[from]=ieri'))
    expect(bad.statusCode).toBe(422)
  })

  it('non mostra dipendenti e mezzi di un’altra azienda', async () => {
    const s = await scene()
    const other = await scene()
    await other.report(other.villa, '2026-10-01', 'approved', { verdi: '8', digger: '8' })
    expect((await s.browser.call('GET', employeeUrl(s.slug, other.verdi))).statusCode).toBe(404)
    expect((await s.browser.call('GET', vehicleUrl(s.slug, other.digger))).statusCode).toBe(404)
    // Its own employee does not see the hours of the other company either.
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '2' })
    const own = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(own.json<Summary>().hours).toBe('2.00')
  })

  it('404 senza il permesso della scheda o per un id inesistente, 403 senza reports.view', async () => {
    const noCard = await scene(['reports.view'])
    expect(
      (await noCard.browser.call('GET', employeeUrl(noCard.slug, noCard.verdi))).statusCode,
    ).toBe(404)
    expect(
      (await noCard.browser.call('GET', vehicleUrl(noCard.slug, noCard.digger))).statusCode,
    ).toBe(404)
    const noReports = await scene(['employees.view', 'vehicles.view'])
    expect(
      (await noReports.browser.call('GET', employeeUrl(noReports.slug, noReports.verdi)))
        .statusCode,
    ).toBe(403)
    expect(
      (await noReports.browser.call('GET', vehicleUrl(noReports.slug, noReports.digger)))
        .statusCode,
    ).toBe(403)
    const s = await scene()
    const missing = '0b8f6a52-3c1e-4d7a-9f20-6f1b2c3d4e5f'
    expect((await s.browser.call('GET', employeeUrl(s.slug, missing))).statusCode).toBe(404)
    expect((await s.browser.call('GET', employeeUrl(s.slug, 'non-un-id'))).statusCode).toBe(404)
  })

  it('401 senza sessione', async () => {
    const s = await scene()
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', employeeUrl(s.slug, s.verdi))).statusCode).toBe(401)
  })
})

describe('ore di dipendenti e mezzi per cantiere in CSV', () => {
  const lines = (body: string) => body.replace('\uFEFF', '').trim().split('\r\n')

  it('le stesse righe del riepilogo, con il totale in fondo', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', digger: '3.5' })
    await s.report(s.villa, '2026-10-02', 'submitted', { verdi: '7.5' })
    await s.report(s.condo, '2026-10-02', 'draft', { verdi: '1', bassi: '8' })
    await s.report(s.condo, '2026-09-30', 'approved', { verdi: '0.33' })
    await s.report(s.condo, '2026-10-05', 'approved', { verdi: '10', digger: '2' })
    await ctx.owner.query(`update public.sites set name = 'Villetta; "nord"' where id = $1`, [
      s.villa,
    ])

    const res = await s.browser.call('GET', `${employeeUrl(s.slug, s.verdi)}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="ore-dipendente.csv"')
    expect(lines(res.body)).toEqual([
      'Codice;Cantiere;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      'C-1;"Villetta; ""nord""";15,50;2;441,75;01/10/2026;02/10/2026',
      ';Condominio;11,33;3;322,91;30/09/2026;05/10/2026',
      ';Totale;26,83;4;764,66;;',
    ])

    // Same filters as the summary; no hourly cost leaves the cost empty.
    const filtered = await s.browser.call(
      'GET',
      `${employeeUrl(s.slug, s.bassi)}/export?filter[from]=2026-10-02&filter[to]=2026-10-02`,
    )
    expect(lines(filtered.body)).toEqual([
      'Codice;Cantiere;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      ';Condominio;8,00;1;;02/10/2026;02/10/2026',
      ';Totale;8,00;1;;;',
    ])
    const approved = await s.browser.call(
      'GET',
      `${vehicleUrl(s.slug, s.digger)}/export?filter[status]=approved`,
    )
    expect(approved.statusCode).toBe(200)
    expect(approved.headers['content-disposition']).toBe('attachment; filename="ore-mezzo.csv"')
    expect(lines(approved.body)).toEqual([
      'Codice;Cantiere;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      'C-1;"Villetta; ""nord""";3,50;1;157,50;01/10/2026;01/10/2026',
      ';Condominio;2,00;1;90,00;05/10/2026;05/10/2026',
      ';Totale;5,50;2;247,50;;',
    ])

    // Without hours: only the header and a zero total.
    const empty = await scene()
    const none = await empty.browser.call('GET', `${vehicleUrl(empty.slug, empty.digger)}/export`)
    expect(lines(none.body)).toEqual([
      'Codice;Cantiere;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      ';Totale;0,00;0;0,00;;',
    ])
  })

  it('422, un’altra azienda, 404, 403 e 401', async () => {
    const s = await scene()
    const bad = await s.browser.call(
      'GET',
      `${employeeUrl(s.slug, s.verdi)}/export?filter[from]=2026-11-10&filter[to]=2026-11-01`,
    )
    expect(bad.statusCode).toBe(422)
    expect(
      (await s.browser.call('GET', `${vehicleUrl(s.slug, s.digger)}/export?filter[status]=boh`))
        .statusCode,
    ).toBe(422)

    const other = await scene()
    await other.report(other.villa, '2026-10-01', 'approved', { verdi: '8', digger: '8' })
    expect(
      (await s.browser.call('GET', `${employeeUrl(s.slug, other.verdi)}/export`)).statusCode,
    ).toBe(404)
    expect(
      (await s.browser.call('GET', `${vehicleUrl(s.slug, other.digger)}/export`)).statusCode,
    ).toBe(404)
    expect(
      (await s.browser.call('GET', `${employeeUrl(s.slug, 'non-un-id')}/export`)).statusCode,
    ).toBe(404)

    const noCard = await scene(['reports.view'])
    expect(
      (await noCard.browser.call('GET', `${employeeUrl(noCard.slug, noCard.verdi)}/export`))
        .statusCode,
    ).toBe(404)
    expect(
      (await noCard.browser.call('GET', `${vehicleUrl(noCard.slug, noCard.digger)}/export`))
        .statusCode,
    ).toBe(404)
    const noReports = await scene(['employees.view', 'vehicles.view'])
    expect(
      (
        await noReports.browser.call(
          'GET',
          `${employeeUrl(noReports.slug, noReports.verdi)}/export`,
        )
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await noReports.browser.call(
          'GET',
          `${vehicleUrl(noReports.slug, noReports.digger)}/export`,
        )
      ).statusCode,
    ).toBe(403)

    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', `${employeeUrl(s.slug, s.verdi)}/export`)).statusCode).toBe(
      401,
    )
  })
})

const siteUrl = (slug: string, id: string, query = '') =>
  `/api/companies/${slug}/sites/${id}/work-summary${query}`

const SITE: Permission[] = ['sites.view', 'reports.view', 'costs.view']

interface SiteSummary {
  labor: {
    hours: string
    cost: string | null
    rows: { employee: { id: string; first_name: string; last_name: string }; cost: string | null }[]
  }
  vehicles: {
    hours: string
    cost: string | null
    rows: { vehicle: { id: string; name: string; plate: string | null }; cost: string | null }[]
  }
}

describe('ore di un cantiere per dipendente e per mezzo', () => {
  it('somma per dipendente e per mezzo, da chi ha più ore, con i costi', async () => {
    const s = await scene(SITE)
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', bassi: '4', digger: '3.5' })
    await s.report(s.villa, '2026-10-02', 'draft', { bassi: '8' })
    await s.report(s.condo, '2026-10-02', 'approved', { verdi: '8', digger: '8' })

    const res = await s.browser.call('GET', siteUrl(s.slug, s.villa))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      labor: {
        hours: '20.00',
        // Bassi has no hourly cost: zero in the total, null in the row.
        cost: '228.00',
        rows: [
          {
            employee: { id: s.bassi, first_name: 'Anna', last_name: 'Bassi' },
            hours: '12.00',
            days: 2,
            cost: null,
            first_date: '2026-10-01',
            last_date: '2026-10-02',
          },
          {
            employee: { id: s.verdi, first_name: 'Luca', last_name: 'Verdi' },
            hours: '8.00',
            days: 1,
            cost: '228.00',
            first_date: '2026-10-01',
            last_date: '2026-10-01',
          },
        ],
      },
      vehicles: {
        hours: '3.50',
        cost: '157.50',
        rows: [
          {
            vehicle: { id: s.digger, name: 'Escavatore', plate: null },
            hours: '3.50',
            days: 1,
            cost: '157.50',
            first_date: '2026-10-01',
            last_date: '2026-10-01',
          },
        ],
      },
    })

    const approved = await s.browser.call(
      'GET',
      siteUrl(s.slug, s.villa, '?filter[status]=approved'),
    )
    expect(approved.json<SiteSummary>().labor).toMatchObject({ hours: '12.00', cost: '228.00' })
    const empty = await s.browser.call('GET', siteUrl(s.slug, s.villa, '?filter[from]=2026-10-03'))
    expect(empty.json()).toEqual({
      labor: { hours: '0.00', cost: '0.00', rows: [] },
      vehicles: { hours: '0.00', cost: '0.00', rows: [] },
    })
  })

  it('senza costs.view i costi sono null, le ore no', async () => {
    const s = await scene(['sites.view', 'reports.view'])
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', digger: '2' })
    const body = (await s.browser.call('GET', siteUrl(s.slug, s.villa))).json<SiteSummary>()
    expect(body.labor).toMatchObject({ hours: '8.00', cost: null, rows: [{ cost: null }] })
    expect(body.vehicles).toMatchObject({ hours: '2.00', cost: null, rows: [{ cost: null }] })
  })

  it('422, un’altra azienda, 404, 403 e 401', async () => {
    const s = await scene(SITE)
    const bad = await s.browser.call('GET', siteUrl(s.slug, s.villa, '?filter[to]=2026-13-01'))
    expect(bad.statusCode).toBe(422)

    const other = await scene(SITE)
    await other.report(other.villa, '2026-10-01', 'approved', { verdi: '8' })
    expect((await s.browser.call('GET', siteUrl(s.slug, other.villa))).statusCode).toBe(404)
    // The site of the other company through its own slug is not reachable either.
    expect((await s.browser.call('GET', siteUrl(other.slug, other.villa))).statusCode).toBe(404)

    const noSites = await scene(['reports.view', 'costs.view'])
    expect(
      (await noSites.browser.call('GET', siteUrl(noSites.slug, noSites.villa))).statusCode,
    ).toBe(404)
    const noReports = await scene(['sites.view', 'costs.view'])
    expect(
      (await noReports.browser.call('GET', siteUrl(noReports.slug, noReports.villa))).statusCode,
    ).toBe(403)
    expect((await s.browser.call('GET', siteUrl(s.slug, 'x'))).statusCode).toBe(404)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', siteUrl(s.slug, s.villa))).statusCode).toBe(401)
  })
})

describe('ore di un cantiere per dipendente e per mezzo in CSV', () => {
  const lines = (body: string) => body.replace('\uFEFF', '').trim().split('\r\n')

  it('le stesse righe del riepilogo, con i totali; il costo solo con costs.view', async () => {
    const s = await scene(SITE)
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', bassi: '4', digger: '3.5' })
    await s.report(s.villa, '2026-10-02', 'draft', { bassi: '8' })
    await s.report(s.condo, '2026-10-02', 'approved', { verdi: '8', digger: '8' })
    await ctx.owner.query(
      `update public.vehicles set name = 'Escavatore; "grande"', plate = 'AB123CD' where id = $1`,
      [s.digger],
    )

    const res = await s.browser.call('GET', `${siteUrl(s.slug, s.villa)}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="ore-cantiere.csv"')
    expect(lines(res.body)).toEqual([
      'Tipo;Nome;Targa;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      'Dipendente;Bassi Anna;;12,00;2;;01/10/2026;02/10/2026',
      'Dipendente;Verdi Luca;;8,00;1;228,00;01/10/2026;01/10/2026',
      'Totale dipendenti;;;20,00;;228,00;;',
      'Mezzo;"Escavatore; ""grande""";AB123CD;3,50;1;157,50;01/10/2026;01/10/2026',
      'Totale mezzi;;;3,50;;157,50;;',
    ])

    const approved = await s.browser.call(
      'GET',
      `${siteUrl(s.slug, s.villa)}/export?filter[status]=approved&filter[to]=2026-10-01`,
    )
    expect(lines(approved.body)).toEqual([
      'Tipo;Nome;Targa;Ore;Giorni;Costo;Primo giorno;Ultimo giorno',
      'Dipendente;Verdi Luca;;8,00;1;228,00;01/10/2026;01/10/2026',
      'Dipendente;Bassi Anna;;4,00;1;;01/10/2026;01/10/2026',
      'Totale dipendenti;;;12,00;;228,00;;',
      'Mezzo;"Escavatore; ""grande""";AB123CD;3,50;1;157,50;01/10/2026;01/10/2026',
      'Totale mezzi;;;3,50;;157,50;;',
    ])

    const plain = await scene(['sites.view', 'reports.view'])
    await plain.report(plain.villa, '2026-10-01', 'approved', { verdi: '8' })
    const noCosts = await plain.browser.call('GET', `${siteUrl(plain.slug, plain.villa)}/export`)
    expect(lines(noCosts.body)).toEqual([
      'Tipo;Nome;Targa;Ore;Giorni;Primo giorno;Ultimo giorno',
      'Dipendente;Verdi Luca;;8,00;1;01/10/2026;01/10/2026',
      'Totale dipendenti;;;8,00;;;',
      'Totale mezzi;;;0,00;;;',
    ])
  })

  it('422, un’altra azienda, 404, 403 e 401', async () => {
    const s = await scene(SITE)
    const url = (x: { slug: string }, site: string, query = '') =>
      `${siteUrl(x.slug, site)}/export${query}`
    expect((await s.browser.call('GET', url(s, s.villa, '?filter[status]=boh'))).statusCode).toBe(
      422,
    )
    const other = await scene(SITE)
    await other.report(other.villa, '2026-10-01', 'approved', { verdi: '8' })
    expect((await s.browser.call('GET', url(s, other.villa))).statusCode).toBe(404)
    expect((await s.browser.call('GET', url(other, other.villa))).statusCode).toBe(404)
    expect((await s.browser.call('GET', url(s, 'x'))).statusCode).toBe(404)
    const noSites = await scene(['reports.view', 'costs.view'])
    expect((await noSites.browser.call('GET', url(noSites, noSites.villa))).statusCode).toBe(404)
    const noReports = await scene(['sites.view', 'costs.view'])
    expect((await noReports.browser.call('GET', url(noReports, noReports.villa))).statusCode).toBe(
      403,
    )
    expect((await new Browser(ctx.app).call('GET', url(s, s.villa))).statusCode).toBe(401)
  })
})

describe('ore mensili dei dipendenti per cantiere in CSV', () => {
  const url = (slug: string, query: string) =>
    `/api/companies/${slug}/daily-reports/monthly-site-hours?${query}`
  const lines = (body: string) => body.replace('﻿', '').trim().split('\r\n')

  it('una riga per dipendente e cantiere, con giorni e ore del mese', async () => {
    const s = await scene(['reports.view', 'employees.view'])
    await ctx.owner.query("update public.sites set address = 'Via Roma 1, Treviso' where id = $1", [
      s.villa,
    ])
    await ctx.owner.query(
      "update public.employees set tax_code = 'VRDLCU80A01H501U' where id = $1",
      [s.verdi],
    )
    await s.report(s.villa, '2026-11-02', 'approved', { verdi: '8', bassi: '7.5' })
    await s.report(s.villa, '2026-11-03', 'draft', { verdi: '4.25' })
    await s.report(s.condo, '2026-11-03', 'approved', { verdi: '4' })
    // Other months stay out.
    await s.report(s.villa, '2026-10-31', 'approved', { verdi: '9' })
    await s.report(s.villa, '2026-12-01', 'approved', { verdi: '9' })

    const res = await s.browser.call('GET', url(s.slug, 'month=2026-11'))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="ore-cantieri-2026-11.csv"',
    )
    expect(lines(res.body)).toEqual([
      'Cognome;Nome;Codice fiscale;Cantiere;Codice cantiere;Indirizzo cantiere;Giorni;Ore',
      'Bassi;Anna;;Villetta;C-1;Via Roma 1, Treviso;1;7,5',
      'Verdi;Luca;VRDLCU80A01H501U;Condominio;;;1;4',
      'Verdi;Luca;VRDLCU80A01H501U;Villetta;C-1;Via Roma 1, Treviso;2;12,25',
    ])

    const approved = await s.browser.call(
      'GET',
      url(s.slug, 'month=2026-11&filter[status]=approved'),
    )
    expect(lines(approved.body).slice(1)).toEqual([
      'Bassi;Anna;;Villetta;C-1;Via Roma 1, Treviso;1;7,5',
      'Verdi;Luca;VRDLCU80A01H501U;Condominio;;;1;4',
      'Verdi;Luca;VRDLCU80A01H501U;Villetta;C-1;Via Roma 1, Treviso;1;8',
    ])
    const condo = await s.browser.call('GET', url(s.slug, `month=2026-11&filter[site]=${s.condo}`))
    expect(lines(condo.body).slice(1)).toEqual(['Verdi;Luca;VRDLCU80A01H501U;Condominio;;;1;4'])

    for (const [query, field] of [
      ['', 'month'],
      ['month=2026-13', 'month'],
      ['month=2026-11&filter[status]=nope', 'filter[status]'],
      ['month=2026-11&filter[site]=x', 'filter[site]'],
    ] as const) {
      const bad = await s.browser.call('GET', url(s.slug, query))
      expect(bad.statusCode).toBe(422)
      expect(bad.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty([field])
    }
  })

  it('un’altra azienda vede solo le sue ore; servono entrambi i permessi', async () => {
    const s = await scene(['reports.view', 'employees.view'])
    await s.report(s.villa, '2026-11-02', 'approved', { verdi: '8' })
    const theirs = await scene(['reports.view', 'employees.view'])
    const other = await theirs.browser.call('GET', url(theirs.slug, 'month=2026-11'))
    expect(lines(other.body)).toHaveLength(1)
    expect((await theirs.browser.call('GET', url(s.slug, 'month=2026-11'))).statusCode).toBe(404)

    for (const permissions of [['reports.view'], ['employees.view']] as Permission[][]) {
      const guest = await scene(permissions)
      expect((await guest.browser.call('GET', url(guest.slug, 'month=2026-11'))).statusCode).toBe(
        403,
      )
    }
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', url(s.slug, 'month=2026-11'))).statusCode).toBe(401)
  })
})
