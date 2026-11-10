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
  'reports.approve',
  'costs.view',
  'employees.view',
  'vehicles.view',
  'sites.view',
]

async function scene() {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta') returning id`,
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    // Bassi has no hourly cost: a day lost to bad weather is no missing cost.
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', null) returning id`,
    [company.id],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, kind, name, hourly_cost_cents)
     values ($1, 'machine', 'Escavatore', 4000) returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    vehicle: vehicle.rows[0]?.id ?? '',
    api: `/api/companies/${company.slug}`,
    base: `/api/companies/${company.slug}/daily-reports`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

function body(s: Scene, labor: unknown[], date = '2026-11-06', vehicles: unknown[] = []) {
  return {
    site_id: s.site,
    date,
    weather: 'Pioggia',
    work_done: null,
    notes: null,
    labor,
    vehicles,
  }
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

describe('a whole day lost to bad weather', () => {
  it('takes a row with no worked hours when the hours are lost to bad weather', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '0', weather_hours: '8', description: null },
        { employee_id: s.bassi, hours: '0.00', weather_hours: '8', description: null },
      ]),
    })
    expect(created.statusCode).toBe(201)
    const report = created.json<{
      id: string
      total_labor_hours: string
      labor: { hours: string; weather_hours: string }[]
    }>()
    expect(report.total_labor_hours).toBe('0.00')
    expect(report.labor.map((l) => [l.hours, l.weather_hours])).toEqual([
      ['0.00', '8.00'],
      ['0.00', '8.00'],
    ])
    const pdf = await s.browser.call('GET', `${s.base}/${report.id}/pdf`)
    expect(pdf.statusCode).toBe(200)

    // The lost hours of the day are in the list and in its CSV, outside the hours worked.
    const list = await s.browser.call('GET', s.base)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: { total_weather_hours: string }[] }>().data).toEqual([
      expect.objectContaining({ total_labor_hours: '0.00', total_weather_hours: '16.00' }),
    ])
    const csv = await s.browser.call('GET', `${s.base}/export`)
    expect(csvLines(csv.body)[0]?.split(';').at(-3)).toBe('Ore perse per maltempo')
    expect(csvLines(csv.body)[1]?.split(';').slice(-4, -1)).toEqual(['0,00', '16,00', '0'])
  })

  it('still rejects a row with neither worked nor lost hours, and zero hours of vehicles', async () => {
    const s = await scene()
    for (const weather_hours of [undefined, null, '0']) {
      const res = await s.browser.call('POST', s.base, {
        body: body(s, [{ employee_id: s.verdi, hours: '0', weather_hours, description: null }]),
      })
      expect(res.statusCode, String(weather_hours)).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['labor.0.hours'])
    }
    // Overtime cannot go beyond the zero hours worked.
    const overtime = await s.browser.call('POST', s.base, {
      body: body(s, [
        {
          employee_id: s.verdi,
          hours: '0',
          overtime_hours: '1',
          weather_hours: '8',
          description: null,
        },
      ]),
    })
    expect(overtime.statusCode).toBe(422)
    expect(Object.keys(overtime.json<{ errors: object }>().errors)).toEqual([
      'labor.0.overtime_hours',
    ])
    const machine = await s.browser.call('POST', s.base, {
      body: body(s, [], '2026-11-06', [{ vehicle_id: s.vehicle, hours: '0', description: null }]),
    })
    expect(machine.statusCode).toBe(422)
    expect(Object.keys(machine.json<{ errors: object }>().errors)).toEqual(['vehicles.0.hours'])

    // The database says the same.
    const report = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date)
       values ($1, $2, '2026-11-06') returning id`,
      [s.company.id, s.site],
    )
    await expect(
      ctx.owner.query(
        `insert into public.daily_report_labor
           (company_id, report_id, employee_id, hours, weather_hours, position)
         values ($1, $2, $3, 0, 0, 0)`,
        [s.company.id, report.rows[0]?.id, s.verdi],
      ),
    ).rejects.toThrow(/daily_report_labor_hours_check/)
  })

  it('is not a day worked in the hour summaries and in the monthly hours by site', async () => {
    const s = await scene()
    const report = async (date: string, hours: string, weather_hours: string) => {
      const res = await s.browser.call('POST', s.base, {
        body: body(s, [{ employee_id: s.verdi, hours, weather_hours, description: null }], date),
      })
      expect(res.statusCode).toBe(201)
    }
    await report('2026-11-05', '8', '0')
    await report('2026-11-06', '0', '8')

    const bySite = await s.browser.call('GET', `${s.base}/monthly-site-hours?month=2026-11`)
    expect(bySite.statusCode).toBe(200)
    expect(csvLines(bySite.body).slice(1)).toEqual(['Verdi;Luca;;Villetta;;;1;8;0;0;0;8'])

    // The monthly sheet has no cell for the lost day, only the lost hours at the end.
    const monthly = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-11`)
    const cells = csvLines(monthly.body)[1]?.split(';') ?? []
    expect(cells[3 + 4]).toBe('8')
    expect(cells[3 + 5]).toBe('')
    expect(cells.at(-1)).toBe('8')

    const employee = await s.browser.call('GET', `${s.api}/employees/${s.verdi}/work-summary`)
    expect(employee.statusCode).toBe(200)
    expect(employee.json()).toMatchObject({
      hours: '8.00',
      days: 1,
      sites: [{ hours: '8.00', days: 1, first_date: '2026-11-05', last_date: '2026-11-05' }],
    })
    const site = await s.browser.call('GET', `${s.api}/sites/${s.site}/work-summary`)
    expect(site.statusCode).toBe(200)
    expect(site.json()).toMatchObject({
      labor: { rows: [{ hours: '8.00', days: 1, last_date: '2026-11-05' }] },
    })
  })

  it('counts no missing hourly cost for a lost day and proposes a normal day after it', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(
        s,
        [{ employee_id: s.bassi, hours: '0', weather_hours: '8', description: null }],
        '2026-11-04',
      ),
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    for (const status of ['submitted', 'approved']) {
      const current = await s.browser.call('GET', `${s.base}/${id}`)
      const res = await s.browser.call('POST', `${s.base}/${id}/status`, {
        body: { status },
        headers: { 'If-Match': String(current.headers.etag) },
      })
      expect(res.statusCode).toBe(200)
    }
    const summary = await s.browser.call('GET', `${s.api}/sites/${s.site}/cost-summary`)
    expect(summary.statusCode).toBe(200)
    expect(summary.json<{ missing_hourly_costs: number }>().missing_hourly_costs).toBe(0)

    const copied = await s.browser.call(
      'GET',
      `${s.base}/today?site=${s.site}&date=2026-11-05&copy_previous=true`,
    )
    expect(copied.statusCode).toBe(200)
    expect(copied.json<{ proposal: { labor: unknown[] } }>().proposal.labor).toEqual([
      {
        employee_id: s.bassi,
        hours: '8.00',
        overtime_hours: '0.00',
        travel: false,
        description: null,
      },
    ])
  })
})
