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
  'audit.view',
  'employees.view',
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
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', 3000) returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    slug: company.slug,
    base: `/api/companies/${company.slug}/daily-reports`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

interface Report {
  id: string
  labor: { employee_id: string; hours: string; weather_hours: string }[]
}

function body(s: Scene, labor: unknown[], date = '2026-11-06') {
  return {
    site_id: s.site,
    date,
    weather: 'Pioggia',
    work_done: null,
    notes: null,
    labor,
    vehicles: [],
  }
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

describe('hours lost to bad weather in daily reports', () => {
  it('stores the lost hours of each person, in the PDF and in the change log', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '3', weather_hours: '5', description: null },
        // Absent and null are no hours lost.
        { employee_id: s.bassi, hours: '8', weather_hours: null, description: null },
      ]),
    })
    expect(created.statusCode).toBe(201)
    const report = created.json<Report>()
    expect(report.labor).toEqual([
      expect.objectContaining({ employee_id: s.verdi, hours: '3.00', weather_hours: '5.00' }),
      expect.objectContaining({ employee_id: s.bassi, hours: '8.00', weather_hours: '0.00' }),
    ])

    const pdf = (await s.browser.call('GET', `${s.base}/${report.id}/pdf`)).rawPayload.toString(
      'latin1',
    )
    expect(pdf).toContain('(Verdi Luca \\(maltempo 5\\))')
    expect(pdf).toContain('(Bassi Anna)')

    // The lost hours have no cost: only the three hours worked count.
    const costs = await ctx.owner.query<{ cents: string }>(
      `select sum(l.hours * e.hourly_cost_cents)::bigint::text as cents
       from public.daily_report_labor l join public.employees e on e.id = l.employee_id
       where l.report_id = $1 and l.employee_id = $2`,
      [report.id, s.verdi],
    )
    expect(costs.rows[0]?.cents).toBe('8400')

    // Changing only the lost hours is a change of the labor rows, in the change log.
    const url = `${s.base}/${report.id}`
    const updated = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '3', weather_hours: '4.5', description: null },
        { employee_id: s.bassi, hours: '8', description: null },
      ]),
      headers: { 'If-Match': String(created.headers.etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Report>().labor[0]?.weather_hours).toBe('4.50')
    const logUrl = `/api/companies/${s.slug}/audit-log?filter[entity]=daily_report&filter[field]=labor`
    const log = await s.browser.call('GET', logUrl)
    expect(log.statusCode).toBe(200)
    expect(log.json<{ data: unknown[] }>().data).toHaveLength(1)

    // Saving the same rows again leaves no new entry.
    const same = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '3', weather_hours: '4.50', description: null },
        { employee_id: s.bassi, hours: '8', weather_hours: '0', description: null },
      ]),
      headers: { 'If-Match': String(updated.headers.etag) },
    })
    expect(same.statusCode).toBe(200)
    expect((await s.browser.call('GET', logUrl)).json<{ data: unknown[] }>().data).toHaveLength(1)
  })

  it('rejects lost hours that are not valid or that with the hours go beyond 24', async () => {
    const s = await scene()
    for (const weather_hours of ['-1', 'tanta', '25', 5, '20']) {
      const res = await s.browser.call('POST', s.base, {
        body: body(s, [{ employee_id: s.verdi, hours: '8', weather_hours, description: null }]),
      })
      expect(res.statusCode, JSON.stringify(weather_hours)).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['labor.0.weather_hours'])
    }
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
         values ($1, $2, $3, 8, 17, 0)`,
        [s.company.id, report.rows[0]?.id, s.verdi],
      ),
    ).rejects.toThrow(/daily_report_labor_weather_hours_check/)
  })

  it('sums the lost hours of the month for the payroll, in total and by site', async () => {
    const s = await scene()
    const other = await ctx.owner.query<{ id: string }>(
      `insert into public.sites (company_id, name) values ($1, 'Condominio') returning id`,
      [s.company.id],
    )
    const condo = other.rows[0]?.id ?? ''
    const report = async (site: string, date: string, weather_hours: string | undefined) => {
      const res = await s.browser.call('POST', s.base, {
        body: {
          ...body(
            s,
            [{ employee_id: s.verdi, hours: '4', weather_hours, description: null }],
            date,
          ),
          site_id: site,
        },
      })
      expect(res.statusCode).toBe(201)
    }
    await report(s.site, '2026-11-05', '4')
    await report(condo, '2026-11-06', '2.5')
    await report(s.site, '2026-11-09', undefined)
    await report(s.site, '2026-12-01', '8')

    const monthly = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-11`)
    expect(monthly.statusCode).toBe(200)
    const lines = csvLines(monthly.body)
    expect(lines[0]?.split(';').at(-1)).toBe('Ore perse per maltempo')
    expect(lines[1]?.split(';').slice(-5)).toEqual(['12', '0', '0', '0', '6,5'])

    const bySite = await s.browser.call('GET', `${s.base}/monthly-site-hours?month=2026-11`)
    expect(bySite.statusCode).toBe(200)
    const siteLines = csvLines(bySite.body)
    expect(siteLines[0]?.split(';').at(-1)).toBe('Ore perse per maltempo')
    expect(siteLines.slice(1)).toEqual([
      'Verdi;Luca;;Condominio;;;1;4;0;0;0;2,5',
      'Verdi;Luca;;Villetta;;;2;8;0;0;0;4',
    ])

    // Another company sees none of it.
    const theirs = await scene()
    const res = await theirs.browser.call('GET', `${theirs.base}/monthly-hours?month=2026-11`)
    expect(csvLines(res.body)).toHaveLength(1)
  })

  it('does not copy the lost hours in the proposal of today', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(
        s,
        [{ employee_id: s.verdi, hours: '4', weather_hours: '4', description: null }],
        '2026-11-04',
      ),
    })
    expect(created.statusCode).toBe(201)
    const copied = await s.browser.call(
      'GET',
      `${s.base}/today?site=${s.site}&date=2026-11-05&copy_previous=true`,
    )
    expect(copied.statusCode).toBe(200)
    expect(copied.json<{ proposal: { labor: unknown[] } }>().proposal.labor).toEqual([
      {
        employee_id: s.verdi,
        hours: '4.00',
        overtime_hours: '0.00',
        travel: false,
        description: null,
      },
    ])
  })
})
