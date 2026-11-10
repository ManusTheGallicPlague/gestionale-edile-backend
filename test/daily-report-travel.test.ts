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
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', 4500) returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    digger: vehicle.rows[0]?.id ?? '',
    slug: company.slug,
    base: `/api/companies/${company.slug}/daily-reports`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

interface Report {
  id: string
  labor: { employee_id: string; hours: string; travel: boolean }[]
}

function body(s: Scene, labor: unknown[], date = '2026-11-05') {
  return {
    site_id: s.site,
    date,
    weather: null,
    work_done: null,
    notes: null,
    labor,
    vehicles: [{ vehicle_id: s.digger, hours: '3', description: null }],
  }
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

describe('travel in daily reports', () => {
  it('stores the travel flag of each person, in the PDF and in the change log', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '8', travel: true, description: null },
        // Absent and null are no travel.
        { employee_id: s.bassi, hours: '8', description: null },
      ]),
    })
    expect(created.statusCode).toBe(201)
    const report = created.json<Report>()
    expect(report.labor).toEqual([
      expect.objectContaining({ employee_id: s.verdi, travel: true }),
      expect.objectContaining({ employee_id: s.bassi, travel: false }),
    ])

    const pdf = (await s.browser.call('GET', `${s.base}/${report.id}/pdf`)).rawPayload.toString(
      'latin1',
    )
    expect(pdf).toContain('(Verdi Luca \\(trasferta\\))')
    expect(pdf).toContain('(Bassi Anna)')

    // Changing only the travel flag is a change of the labor rows, in the change log.
    const url = `${s.base}/${report.id}`
    const updated = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '8', travel: false, description: null },
        { employee_id: s.bassi, hours: '8', overtime_hours: '1', travel: true, description: null },
      ]),
      headers: { 'If-Match': String(created.headers.etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Report>().labor).toEqual([
      expect.objectContaining({ employee_id: s.verdi, travel: false }),
      expect.objectContaining({ employee_id: s.bassi, travel: true }),
    ])
    const after = (await s.browser.call('GET', `${s.base}/${report.id}/pdf`)).rawPayload.toString(
      'latin1',
    )
    expect(after).toContain('(Bassi Anna \\(straordinario 1, trasferta\\))')
    const logUrl = `/api/companies/${s.slug}/audit-log?filter[entity]=daily_report&filter[field]=labor`
    const log = await s.browser.call('GET', logUrl)
    expect(log.statusCode).toBe(200)
    expect(log.json<{ data: unknown[] }>().data).toHaveLength(1)

    // Saving the same rows again (travel absent is false) leaves no new entry.
    const same = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '8', description: null },
        { employee_id: s.bassi, hours: '8', overtime_hours: '1', travel: true, description: null },
      ]),
      headers: { 'If-Match': String(updated.headers.etag) },
    })
    expect(same.statusCode).toBe(200)
    expect((await s.browser.call('GET', logUrl)).json<{ data: unknown[] }>().data).toHaveLength(1)
  })

  it('rejects a travel flag that is not true or false', async () => {
    const s = await scene()
    for (const travel of ['true', 1, 'sì', {}]) {
      const res = await s.browser.call('POST', s.base, {
        body: body(s, [{ employee_id: s.verdi, hours: '8', travel, description: null }]),
      })
      expect(res.statusCode, JSON.stringify(travel)).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['labor.0.travel'])
    }
  })

  it('counts the days of travel of the month for the payroll, once per day', async () => {
    const s = await scene()
    const other = await ctx.owner.query<{ id: string }>(
      `insert into public.sites (company_id, name) values ($1, 'Condominio') returning id`,
      [s.company.id],
    )
    const condo = other.rows[0]?.id ?? ''
    const report = async (site: string, date: string, travel: boolean | undefined) => {
      const res = await s.browser.call('POST', s.base, {
        body: {
          ...body(s, [{ employee_id: s.verdi, hours: '4', travel, description: null }], date),
          site_id: site,
          vehicles: [],
        },
      })
      expect(res.statusCode).toBe(201)
    }
    // Two sites on the 5th, both in travel: one day. The 6th in travel, the 9th not, December out.
    await report(s.site, '2026-11-05', true)
    await report(condo, '2026-11-05', true)
    await report(s.site, '2026-11-06', true)
    await report(s.site, '2026-11-09', undefined)
    await report(s.site, '2026-12-01', true)

    const monthly = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-11`)
    expect(monthly.statusCode).toBe(200)
    const lines = csvLines(monthly.body)
    expect(lines[0]?.split(';').slice(-3, -1)).toEqual(['Giorni di trasferta', 'Di cui festive'])
    expect(lines[1]?.split(';').slice(-5, -1)).toEqual(['16', '0', '2', '0'])

    // By site: the Villetta has two days of travel, the Condominio one.
    const bySite = await s.browser.call('GET', `${s.base}/monthly-site-hours?month=2026-11`)
    expect(bySite.statusCode).toBe(200)
    expect(csvLines(bySite.body).slice(1)).toEqual([
      'Verdi;Luca;;Condominio;;;1;4;0;1;0;0',
      'Verdi;Luca;;Villetta;;;3;12;0;2;0;0',
    ])

    // Another company sees none of it.
    const theirs = await scene()
    const res = await theirs.browser.call('GET', `${theirs.base}/monthly-hours?month=2026-11`)
    expect(csvLines(res.body)).toHaveLength(1)
  })

  it('copies the travel of the previous report in the proposal of today', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(
        s,
        [{ employee_id: s.verdi, hours: '8', travel: true, description: null }],
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
        hours: '8.00',
        overtime_hours: '0.00',
        travel: true,
        description: null,
      },
    ])
  })

  it('counts the people on travel in the list and in the CSV of the reports', async () => {
    const s = await scene()
    const travel = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '8', travel: true, description: null },
        { employee_id: s.bassi, hours: '8', travel: true, description: null },
      ]),
    })
    expect(travel.statusCode).toBe(201)
    expect(travel.json<{ travel_count: number }>().travel_count).toBe(2)
    const home = await s.browser.call('POST', s.base, {
      body: body(
        s,
        [
          { employee_id: s.verdi, hours: '8', travel: true, description: null },
          { employee_id: s.bassi, hours: '8', description: null },
        ],
        '2026-11-06',
      ),
    })
    expect(home.statusCode).toBe(201)
    const list = await s.browser.call('GET', `${s.base}?sort=date`)
    expect(list.statusCode).toBe(200)
    expect(
      list.json<{ data: { travel_count: number }[] }>().data.map((r) => r.travel_count),
    ).toEqual([2, 1])
    const csv = await s.browser.call('GET', `${s.base}/export?sort=date`)
    expect(csv.statusCode).toBe(200)
    const lines = csvLines(csv.body)
    expect(lines[0]?.split(';').at(-2)).toBe('Dipendenti in trasferta')
    expect(lines.slice(1).map((l) => l.split(';').at(-2))).toEqual(['2', '1'])

    // Another company sees none of it.
    const theirs = await scene()
    const other = await theirs.browser.call('GET', theirs.base)
    expect(other.json<{ data: unknown[] }>().data).toEqual([])
    expect((await theirs.browser.call('GET', `${s.base}/export`)).statusCode).toBe(404)
  })
})
