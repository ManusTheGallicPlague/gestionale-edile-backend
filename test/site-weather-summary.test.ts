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
    // Bassi has no hourly cost.
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', null) returning id`,
    [company.id],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, kind, name, hourly_cost_cents)
     values ($1, 'machine', 'Escavatore', 4000) returning id`,
    [company.id],
  )
  const s = {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    vehicle: vehicle.rows[0]?.id ?? '',
    api: `/api/companies/${company.slug}`,
  }
  const report = async (date: string, labor: unknown[], vehicles: unknown[] = []) => {
    const res = await browser.call('POST', `${s.api}/daily-reports`, {
      body: {
        site_id: s.site,
        date,
        weather: 'Pioggia',
        work_done: null,
        notes: null,
        labor,
        vehicles,
      },
    })
    expect(res.statusCode).toBe(201)
  }
  // Verdi works on the 5th losing two hours, and loses the whole 6th (on travel);
  // Bassi only loses the 6th.
  await report(
    '2026-11-05',
    [{ employee_id: s.verdi, hours: '6', weather_hours: '2', description: null }],
    [{ vehicle_id: s.vehicle, hours: '4', description: null }],
  )
  await report('2026-11-06', [
    { employee_id: s.verdi, hours: '0', weather_hours: '8', travel: true, description: null },
    { employee_id: s.bassi, hours: '0', weather_hours: '8', description: null },
  ])
  return s
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

describe('hours lost to bad weather in the hours of a site', () => {
  it('sums them per employee, with who only lost hours, outside days and costs', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.api}/sites/${s.site}/work-summary`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      labor: {
        hours: '6.00',
        overtime_hours: '0.00',
        travel_days: 0,
        weather_hours: '18.00',
        holiday_hours: '0.00',
        cost: '168.00',
        rows: [
          {
            employee: { id: s.verdi, first_name: 'Luca', last_name: 'Verdi' },
            hours: '6.00',
            days: 1,
            overtime_hours: '0.00',
            travel_days: 0,
            weather_hours: '10.00',
            holiday_hours: '0.00',
            cost: '168.00',
            first_date: '2026-11-05',
            last_date: '2026-11-05',
          },
          {
            employee: { id: s.bassi, first_name: 'Anna', last_name: 'Bassi' },
            hours: '0.00',
            days: 0,
            overtime_hours: '0.00',
            travel_days: 0,
            weather_hours: '8.00',
            holiday_hours: '0.00',
            cost: null,
            first_date: '2026-11-06',
            last_date: '2026-11-06',
          },
        ],
      },
      vehicles: {
        hours: '4.00',
        cost: '160.00',
        rows: [expect.objectContaining({ hours: '4.00', days: 1, last_date: '2026-11-05' })],
      },
    })
  })

  it('keeps the filters: on the lost day only, nobody has days worked', async () => {
    const s = await scene()
    const res = await s.browser.call(
      'GET',
      `${s.api}/sites/${s.site}/work-summary?filter[from]=2026-11-06&filter[to]=2026-11-06`,
    )
    expect(res.statusCode).toBe(200)
    const summary = res.json<{
      labor: { weather_hours: string; rows: Record<string, unknown>[] }
      vehicles: { rows: unknown[] }
    }>()
    expect(summary.labor.weather_hours).toBe('16.00')
    // Same hours: by surname. Verdi's travel on a day without hours is no travel day.
    expect(summary.labor.rows).toEqual([
      expect.objectContaining({ hours: '0.00', days: 0, weather_hours: '8.00', cost: null }),
      expect.objectContaining({
        employee: { id: s.verdi, first_name: 'Luca', last_name: 'Verdi' },
        hours: '0.00',
        days: 0,
        travel_days: 0,
        weather_hours: '8.00',
        holiday_hours: '0.00',
        cost: '0.00',
        first_date: '2026-11-06',
      }),
    ])
    expect(summary.vehicles.rows).toEqual([])
    const approved = await s.browser.call(
      'GET',
      `${s.api}/sites/${s.site}/work-summary?filter[status]=approved`,
    )
    expect(approved.json()).toMatchObject({ labor: { weather_hours: '0.00', rows: [] } })
  })

  it('has the lost hours at the end of the CSV, empty for vehicles', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.api}/sites/${s.site}/work-summary/export`)
    expect(res.statusCode).toBe(200)
    expect(csvLines(res.body)).toEqual([
      'Tipo;Nome;Targa;Ore;Giorni;Costo;Primo giorno;Ultimo giorno;Ore perse per maltempo;Di cui straordinario;Giorni di trasferta;Di cui festive',
      'Dipendente;Verdi Luca;;6,00;1;168,00;05/11/2026;05/11/2026;10,00;0,00;0;0,00',
      'Dipendente;Bassi Anna;;0,00;0;;06/11/2026;06/11/2026;8,00;0,00;0;0,00',
      'Totale dipendenti;;;6,00;;168,00;;;18,00;0,00;0;0,00',
      'Mezzo;Escavatore;;4,00;1;160,00;05/11/2026;05/11/2026;;;;',
      'Totale mezzi;;;4,00;;160,00;;;;;;',
    ])
  })

  it('counts no lost hours of another company, which cannot read them', async () => {
    const s = await scene()
    const other = await scene()
    const mine = await s.browser.call('GET', `${s.api}/sites/${s.site}/work-summary`)
    expect(mine.json()).toMatchObject({ labor: { weather_hours: '18.00' } })
    const theirs = await other.browser.call('GET', `${other.api}/sites/${s.site}/work-summary`)
    expect(theirs.statusCode).toBe(404)
    const cross = await other.browser.call('GET', `${s.api}/sites/${s.site}/work-summary`)
    expect([403, 404]).toContain(cross.statusCode)
  })
})
