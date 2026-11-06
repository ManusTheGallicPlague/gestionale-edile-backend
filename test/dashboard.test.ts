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

const ALL: Permission[] = ['sites.view', 'costs.view', 'reports.view', 'deadlines.view']

interface Dashboard {
  today: string
  sites: Record<string, number> | null
  over_budget:
    { site: { id: string; name: string }; budget: string; total: string; overrun: string }[] | null
  costs_this_month: { month: string; total: string } | null
  reports: { to_approve: number; drafts: number } | null
  deadlines: { title: string; due_on: string; overdue: boolean; amount: string | null }[] | null
}

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Dashboard', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, url: `/api/companies/${company.slug}/dashboard` }
}

/** Dates relative to today in Italy, as the API counts them. */
async function day(offset: number): Promise<string> {
  const { rows } = await ctx.owner.query<{ d: string }>(
    "select ((now() at time zone 'Europe/Rome')::date + $1::int)::text as d",
    [offset],
  )
  return rows[0]?.d ?? ''
}

describe('dashboard', () => {
  it('counts sites, lists those over budget, sums the month and lists near deadlines', async () => {
    const s = await scene()
    const id = s.company.id
    const today = await day(0)
    const sites = await ctx.owner.query<{ id: string; name: string }>(
      `insert into public.sites (company_id, name, status, budget_cents) values
         ($1, 'Sforato poco', 'active', 10000),
         ($1, 'Sforato tanto', 'suspended', 10000),
         ($1, 'Nel budget', 'active', 1000000),
         ($1, 'Chiuso sforato', 'completed', 100),
         ($1, 'Senza budget', 'planned', null)
       returning id, name`,
      [id],
    )
    const site = (name: string) => sites.rows.find((r) => r.name === name)?.id
    const cost = (siteName: string, cents: number, date: string) =>
      ctx.owner.query(
        `insert into public.site_costs (company_id, site_id, cost_date, category, description,
           amount_cents) values ($1, $2, $3, 'materials', 'x', $4)`,
        [id, site(siteName), date, cents],
      )
    await cost('Sforato poco', 10050, '2020-01-15')
    await cost('Sforato tanto', 5000, today)
    await cost('Nel budget', 999, today)
    await cost('Chiuso sforato', 5000, today)
    await cost('Senza budget', 7000, today)
    // Labour of an approved report today: 2 hours at 30.00 €, on «Sforato tanto».
    const worker = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
       values ($1, 'Luca', 'Verdi', 3000) returning id`,
      [id],
    )
    const reports = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status) values
         ($1, $2, $3, 'approved'), ($1, $2, $4, 'submitted'), ($1, $2, $5, 'draft'),
         ($1, $6, $3, 'draft')
       returning id`,
      [id, site('Sforato tanto'), today, await day(-1), await day(-2), site('Nel budget')],
    )
    await ctx.owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 2, 0)`,
      [id, reports.rows[0]?.id, worker.rows[0]?.id],
    )
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, status,
         done_at) values
         ($1, 'Scaduta', $2, 'tax', 12345, 'open', null),
         ($1, 'Oggi', $3, 'durc', null, 'open', null),
         ($1, 'Fra sette giorni', $4, 'other', 100, 'open', null),
         ($1, 'Fra otto giorni', $5, 'other', 100, 'open', null),
         ($1, 'Fatta', $2, 'other', 100, 'done', now())`,
      [id, await day(-3), today, await day(7), await day(8)],
    )

    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const d = res.json<Dashboard>()
    expect(d.today).toBe(today)
    expect(d.sites).toEqual({ planned: 1, active: 2, suspended: 1, completed: 1 })
    expect(d.over_budget?.map((r) => [r.site.name, r.budget, r.total, r.overrun])).toEqual([
      ['Sforato tanto', '100.00', '110.00', '10.00'],
      ['Sforato poco', '100.00', '100.50', '0.50'],
    ])
    // This month: 50 + 9.99 + 50 + 70 by hand, 60 of labour; not the 2020 cost.
    expect(d.costs_this_month).toEqual({ month: today.slice(0, 7), total: '239.99' })
    expect(d.reports).toEqual({ to_approve: 1, drafts: 1 })
    expect(d.deadlines?.map((x) => [x.title, x.overdue, x.amount])).toEqual([
      ['Scaduta', true, '123.45'],
      ['Oggi', false, null],
      ['Fra sette giorni', false, '1.00'],
    ])
  })

  it('leaves out the sections the user may not see, and other companies', async () => {
    const s = await scene(['deadlines.view'])
    const d = (await s.browser.call('GET', s.url)).json<Dashboard>()
    expect(d.sites).toBeNull()
    expect(d.over_budget).toBeNull()
    expect(d.costs_this_month).toBeNull()
    expect(d.reports).toBeNull()
    expect(d.deadlines).toEqual([])
    const sitesOnly = await scene(['sites.view'])
    const e = (await sitesOnly.browser.call('GET', sitesOnly.url)).json<Dashboard>()
    expect(e.sites).not.toBeNull()
    expect(e.over_budget).toBeNull()

    const other = await scene()
    await ctx.owner.query(
      "insert into public.sites (company_id, name, status) values ($1, 'Altrui', 'active')",
      [other.company.id],
    )
    expect((await s.browser.call('GET', other.url)).statusCode).toBe(404)
    const mine = await scene()
    expect((await mine.browser.call('GET', mine.url)).json<Dashboard>().sites).toEqual({
      planned: 0,
      active: 0,
      suspended: 0,
      completed: 0,
    })
    expect((await new Browser(ctx.app).call('GET', mine.url)).statusCode).toBe(401)
  })
})
