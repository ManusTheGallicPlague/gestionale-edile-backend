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

const ALL: Permission[] = ['reports.view', 'employees.view', 'sites.view']

interface Payroll {
  overtime_hours: string
  travel_days: number
  weather_hours: string
}

/** A company with two sites and two employees, and a way to write their daily reports. */
async function scene() {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const ids = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows.map((r) => r.id)
  const [villa = '', condo = ''] = await ids(
    `insert into public.sites (company_id, name) values ($1, 'Villetta'), ($1, 'Condominio')
     returning id`,
  )
  const [verdi = '', bassi = ''] = await ids(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', 2600) returning id`,
  )
  /** A daily report with one labor row. */
  const row = async (
    site: string,
    employee: string,
    date: string,
    status: string,
    line: { hours: string; overtime?: string; travel?: boolean; weather?: string },
  ) => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status)
       values ($1, $2, $3, $4) returning id`,
      [company.id, site, date, status],
    )
    await ctx.owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours,
         overtime_hours, travel, weather_hours, position)
       values ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [
        company.id,
        rows[0]?.id,
        employee,
        line.hours,
        line.overtime ?? '0',
        line.travel ?? false,
        line.weather ?? '0',
      ],
    )
  }
  const payroll = async (employee: string, query = '') => {
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/employees/${employee}/work-summary${query}`,
    )
    expect(res.statusCode).toBe(200)
    return res.json<{ hours: string; days: number; payroll: Payroll }>()
  }
  return { browser, company, villa, condo, verdi, bassi, row, payroll }
}

describe('voci delle buste paga nel riepilogo ore del dipendente', () => {
  it('somma straordinario, giorni di trasferta e ore perse per maltempo dei rapportini', async () => {
    const s = await scene()
    // Travel on two sites the same day counts once.
    await s.row(s.villa, s.verdi, '2026-11-02', 'approved', {
      hours: '6',
      overtime: '1.5',
      travel: true,
    })
    await s.row(s.condo, s.verdi, '2026-11-02', 'submitted', { hours: '4', travel: true })
    await s.row(s.villa, s.verdi, '2026-11-03', 'approved', {
      hours: '9',
      overtime: '1',
      travel: true,
    })
    await s.row(s.villa, s.verdi, '2026-11-04', 'approved', { hours: '3', weather: '5' })
    // A whole day lost to the rain: no hours, no day worked, but the lost hours count.
    await s.row(s.villa, s.verdi, '2026-11-05', 'draft', { hours: '0', weather: '8' })
    // Another month, and another employee: outside the period or not Verdi's.
    await s.row(s.villa, s.verdi, '2026-12-01', 'approved', {
      hours: '10',
      overtime: '2',
      travel: true,
      weather: '1',
    })
    await s.row(s.condo, s.bassi, '2026-11-03', 'approved', {
      hours: '10',
      overtime: '2',
      travel: true,
      weather: '1',
    })

    const november = await s.payroll(s.verdi, '?filter[from]=2026-11-01&filter[to]=2026-11-30')
    expect(november).toMatchObject({ hours: '22.00', days: 3 })
    expect(november.payroll).toEqual({
      overtime_hours: '2.50',
      travel_days: 2,
      weather_hours: '13.00',
    })

    // filter[status] works on these too.
    const approved = await s.payroll(
      s.verdi,
      '?filter[from]=2026-11-01&filter[to]=2026-11-30&filter[status]=approved',
    )
    expect(approved.payroll).toEqual({
      overtime_hours: '2.50',
      travel_days: 2,
      weather_hours: '5.00',
    })
    const drafts = await s.payroll(s.verdi, '?filter[status]=draft')
    expect(drafts).toMatchObject({ hours: '0.00', days: 0 })
    expect(drafts.payroll).toEqual({
      overtime_hours: '0.00',
      travel_days: 0,
      weather_hours: '8.00',
    })

    // Without filters, every report.
    expect((await s.payroll(s.verdi)).payroll).toEqual({
      overtime_hours: '4.50',
      travel_days: 3,
      weather_hours: '14.00',
    })
    expect((await s.payroll(s.bassi)).payroll).toEqual({
      overtime_hours: '2.00',
      travel_days: 1,
      weather_hours: '1.00',
    })
  })

  it('non conta i rapportini di un’altra azienda', async () => {
    const s = await scene()
    const other = await scene()
    await other.row(other.villa, other.verdi, '2026-11-02', 'approved', {
      hours: '8',
      overtime: '1',
      travel: true,
      weather: '2',
    })
    expect((await s.payroll(s.verdi)).payroll).toEqual({
      overtime_hours: '0.00',
      travel_days: 0,
      weather_hours: '0.00',
    })
    expect((await other.payroll(other.verdi)).payroll.travel_days).toBe(1)
    // Verdi of the other company is not reachable from this one.
    const res = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/employees/${other.verdi}/work-summary`,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('straordinario e trasferte per dipendente nel riepilogo ore del cantiere', () => {
  it('somma lo straordinario e conta i giorni di trasferta di ogni dipendente sul cantiere', async () => {
    const s = await scene()
    await s.row(s.villa, s.verdi, '2026-11-02', 'approved', {
      hours: '9',
      overtime: '1',
      travel: true,
    })
    await s.row(s.villa, s.verdi, '2026-11-03', 'draft', { hours: '10', overtime: '2.25' })
    // A whole day lost to the rain is no day worked, even with travel.
    await s.row(s.villa, s.verdi, '2026-11-04', 'draft', { hours: '0', travel: true, weather: '8' })
    // Another site does not count.
    await s.row(s.condo, s.verdi, '2026-11-02', 'approved', { hours: '2', travel: true })
    await s.row(s.villa, s.bassi, '2026-11-05', 'approved', { hours: '8' })

    const res = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.villa}/work-summary`,
    )
    expect(res.statusCode).toBe(200)
    const rows = res.json<{
      labor: { rows: { employee: { id: string }; overtime_hours: string; travel_days: number }[] }
    }>().labor.rows
    expect(rows.map((r) => [r.employee.id, r.overtime_hours, r.travel_days])).toEqual([
      [s.verdi, '3.25', 1],
      [s.bassi, '0.00', 0],
    ])

    const approved = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.villa}/work-summary?filter[status]=approved`,
    )
    expect(
      approved.json<{ labor: { rows: { overtime_hours: string }[] } }>().labor.rows[0],
    ).toMatchObject({ overtime_hours: '1.00', travel_days: 1 })
  })
})

describe('straordinario e trasferte nei totali e nel CSV delle ore del cantiere', () => {
  it('somma lo straordinario e i giorni di trasferta di tutti, e li mette in fondo al CSV', async () => {
    const s = await scene()
    await s.row(s.villa, s.verdi, '2026-11-02', 'approved', {
      hours: '9',
      overtime: '1',
      travel: true,
    })
    // Travel days of every employee add up.
    await s.row(s.villa, s.bassi, '2026-11-03', 'approved', {
      hours: '8',
      overtime: '0.5',
      travel: true,
    })
    // Another site does not count.
    await s.row(s.condo, s.verdi, '2026-11-03', 'approved', {
      hours: '10',
      overtime: '2',
      travel: true,
    })
    const url = `/api/companies/${s.company.slug}/sites/${s.villa}/work-summary`

    const res = await s.browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ labor: unknown }>().labor).toMatchObject({
      hours: '17.00',
      overtime_hours: '1.50',
      travel_days: 2,
    })

    const csv = await s.browser.call('GET', `${url}/export`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.replace('﻿', '').trim().split('\r\n')
    expect(lines.map((l) => l.split(';').slice(-3))).toEqual([
      ['Ore perse per maltempo', 'Di cui straordinario', 'Giorni di trasferta'],
      ['0,00', '1,00', '1'],
      ['0,00', '0,50', '1'],
      ['0,00', '1,50', '2'],
      ['', '', ''],
    ])
    expect(lines[3]?.startsWith('Totale dipendenti;')).toBe(true)

    const draft = await s.browser.call('GET', `${url}?filter[status]=draft`)
    expect(draft.json()).toMatchObject({ labor: { overtime_hours: '0.00', travel_days: 0 } })
  })
})
