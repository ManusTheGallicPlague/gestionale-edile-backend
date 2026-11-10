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
  'vehicles.view',
  'sites.view',
]

async function scene(employeeCents: number | null = 2800) {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta') returning id`,
    [company.id],
  )
  const employee = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', $2) returning id`,
    [company.id, employeeCents],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', 4500) returning id`,
    [company.id],
  )
  const s = {
    browser,
    site: site.rows[0]?.id ?? '',
    employee: employee.rows[0]?.id ?? '',
    vehicle: vehicle.rows[0]?.id ?? '',
    company: `/api/companies/${company.slug}`,
  }
  const created = await browser.call('POST', `${s.company}/daily-reports`, {
    body: {
      site_id: s.site,
      date: '2026-11-05',
      weather: null,
      work_done: null,
      notes: null,
      labor: [{ employee_id: s.employee, hours: '8', description: null }],
      vehicles: [{ vehicle_id: s.vehicle, hours: '3', description: null }],
    },
  })
  expect(created.statusCode).toBe(201)
  return {
    ...s,
    report: created.json<{ id: string }>().id,
    etag: String(created.headers.etag),
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function moveTo(s: Scene, status: string) {
  const res = await s.browser.call('POST', `${s.company}/daily-reports/${s.report}/status`, {
    body: { status },
    headers: { 'If-Match': s.etag },
  })
  expect(res.statusCode).toBe(200)
  s.etag = String(res.headers.etag)
}

async function setCosts(s: Scene, employee: number | null, vehicle: number) {
  await ctx.owner.query('update public.employees set hourly_cost_cents = $2 where id = $1', [
    s.employee,
    employee,
  ])
  await ctx.owner.query('update public.vehicles set hourly_cost_cents = $2 where id = $1', [
    s.vehicle,
    vehicle,
  ])
}

interface Summary {
  labor: { hours: string; amount: string }
  vehicles: { hours: string; amount: string }
  total: string
  missing_hourly_costs: number
}

async function summary(s: Scene) {
  const res = await s.browser.call('GET', `${s.company}/sites/${s.site}/cost-summary`)
  expect(res.statusCode).toBe(200)
  return res.json<Summary>()
}

async function employeeCost(s: Scene) {
  const res = await s.browser.call('GET', `${s.company}/employees/${s.employee}/work-summary`)
  expect(res.statusCode).toBe(200)
  return res.json<{ cost: string | null; sites: { cost: string | null }[] }>()
}

async function siteWork(s: Scene) {
  const res = await s.browser.call('GET', `${s.company}/sites/${s.site}/work-summary`)
  expect(res.statusCode).toBe(200)
  return res.json<{
    labor: { cost: string | null; rows: { cost: string | null }[] }
    vehicles: { cost: string | null; rows: { cost: string | null }[] }
  }>()
}

describe('hourly costs fixed on approval of a daily report', () => {
  it('keeps the costs of approved reports when the hourly costs change', async () => {
    const s = await scene()
    await moveTo(s, 'submitted')
    await moveTo(s, 'approved')
    // Raises in January: December stays at the old hourly costs.
    await setCosts(s, 3500, 6000)
    expect(await summary(s)).toMatchObject({
      labor: { hours: '8.00', amount: '224.00' },
      vehicles: { hours: '3.00', amount: '135.00' },
      total: '359.00',
      missing_hourly_costs: 0,
    })
    const work = await employeeCost(s)
    expect(work.cost).toBe('224.00')
    expect(work.sites[0]?.cost).toBe('224.00')
    const site = await siteWork(s)
    expect(site.labor.cost).toBe('224.00')
    expect(site.labor.rows[0]?.cost).toBe('224.00')
    expect(site.vehicles.cost).toBe('135.00')
    const totals = await s.browser.call('GET', `${s.company}/site-costs/totals`)
    expect(totals.statusCode).toBe(200)
    expect(totals.json<{ data: { total: string }[] }>().data[0]?.total).toBe('359.00')
    const months = await s.browser.call('GET', `${s.company}/sites/${s.site}/cost-summary/months`)
    expect(months.statusCode).toBe(200)
    expect(JSON.stringify(months.json())).toContain('"359.00"')
  })

  it('does not log the copy as a change of the hours', async () => {
    const s = await scene()
    await moveTo(s, 'submitted')
    await moveTo(s, 'approved')
    await moveTo(s, 'draft')
    for (const field of ['labor', 'vehicles']) {
      const log = await s.browser.call(
        'GET',
        `${s.company}/audit-log?filter[entity]=daily_report&filter[field]=${field}`,
      )
      expect(log.statusCode).toBe(200)
      expect(log.json<{ data: unknown[] }>().data).toHaveLength(0)
    }
  })

  it('goes back to the current hourly cost when sent back to draft, and fixes it again', async () => {
    const s = await scene()
    await moveTo(s, 'submitted')
    await moveTo(s, 'approved')
    await setCosts(s, 3500, 6000)
    await moveTo(s, 'draft')
    // Not approved: today's hourly cost, as before.
    expect((await employeeCost(s)).cost).toBe('280.00')
    expect((await summary(s)).labor.amount).toBe('0.00')
    await moveTo(s, 'submitted')
    await moveTo(s, 'approved')
    await setCosts(s, 4000, 7000)
    expect(await summary(s)).toMatchObject({
      labor: { amount: '280.00' },
      vehicles: { amount: '180.00' },
    })
    expect((await employeeCost(s)).cost).toBe('280.00')
  })

  it('uses the current hourly cost when it was missing on approval', async () => {
    const s = await scene(null)
    await moveTo(s, 'submitted')
    await moveTo(s, 'approved')
    expect(await summary(s)).toMatchObject({
      labor: { amount: '0.00' },
      missing_hourly_costs: 1,
    })
    expect((await employeeCost(s)).cost).toBeNull()
    expect((await siteWork(s)).labor.rows[0]?.cost).toBeNull()
    // Filled in later: it counts for the reports approved without it.
    await setCosts(s, 3000, 4500)
    expect(await summary(s)).toMatchObject({
      labor: { amount: '240.00' },
      missing_hourly_costs: 0,
    })
    expect((await employeeCost(s)).cost).toBe('240.00')
  })
})
