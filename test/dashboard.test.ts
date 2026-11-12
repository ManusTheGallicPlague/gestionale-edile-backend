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
  'sites.view',
  'costs.view',
  'reports.view',
  'deadlines.view',
  'invoices.view',
]

interface Dashboard {
  today: string
  sites: Record<string, number> | null
  over_budget:
    { site: { id: string; name: string }; budget: string; total: string; overrun: string }[] | null
  costs_this_month: { month: string; total: string } | null
  costs_by_month:
    { month: string; labor: string; vehicles: string; other: string; total: string }[] | null
  site_progress:
    { site: { name: string }; activities: number; progress: number; planned: number }[] | null
  reports: {
    to_approve: number
    drafts: number
    missing_today: number | null
    missing_week: number | null
  } | null
  deadlines: { title: string; due_on: string; overdue: boolean; amount: string | null }[] | null
  invoices: Record<string, string> | null
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
    expect(d.sites).toEqual({
      planned: 1,
      active: 2,
      suspended: 1,
      completed: 1,
      without_prior_notice: 4,
      past_end: 0,
      ending_soon: 0,
      start_due: 0,
      without_team: 3,
      without_permit: 4,
      without_safety_coordinator: 4,
      without_works_director: 4,
    })
    expect(d.over_budget?.map((r) => [r.site.name, r.budget, r.total, r.overrun])).toEqual([
      ['Sforato tanto', '100.00', '110.00', '10.00'],
      ['Sforato poco', '100.00', '100.50', '0.50'],
    ])
    // This month: 50 + 9.99 + 50 + 70 by hand, 60 of labour; not the 2020 cost.
    expect(d.costs_this_month).toEqual({ month: today.slice(0, 7), total: '239.99' })
    // Active: «Sforato poco» (no report) and «Nel budget» (a draft today): one is missing.
    expect(d.reports).toEqual({ to_approve: 1, drafts: 1, missing_today: 1, missing_week: 1 })
    expect(d.deadlines?.map((x) => [x.title, x.overdue, x.amount])).toEqual([
      ['Scaduta', true, '123.45'],
      ['Oggi', false, null],
      ['Fra sette giorni', false, '1.00'],
    ])
  })

  it('gives the costs of the last 12 months and the progress of active sites', async () => {
    const s = await scene()
    const id = s.company.id
    const today = await day(0)
    const { rows: m } = await ctx.owner.query<{ month: string; first: string; old: string }>(
      `select to_char(d, 'YYYY-MM') as month, to_char(d - interval '11 months', 'YYYY-MM-DD') as first,
         to_char(d - interval '12 months', 'YYYY-MM-DD') as old
       from date_trunc('month', $1::date) d`,
      [today],
    )
    const months = m[0] ?? { month: '', first: '', old: '' }
    const sites = await ctx.owner.query<{ id: string; name: string }>(
      `insert into public.sites (company_id, name, status) values
         ($1, 'In ritardo', 'active'), ($1, 'In anticipo', 'active'),
         ($1, 'Sospeso', 'suspended'), ($1, 'Senza attività', 'active')
       returning id, name`,
      [id],
    )
    const site = (name: string) => sites.rows.find((r) => r.name === name)?.id
    await ctx.owner.query(
      `insert into public.site_costs (company_id, site_id, cost_date, category, description,
         amount_cents) values ($1, $2, $3, 'materials', 'x', 1000), ($1, $2, $4, 'rentals', 'y', 250),
         ($1, $2, $5, 'materials', 'troppo vecchio', 99999)`,
      [id, site('In ritardo'), today, months.first, months.old],
    )
    const worker = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
       values ($1, 'Anna', 'Neri', 2500) returning id`,
      [id],
    )
    const vehicle = await ctx.owner.query<{ id: string }>(
      `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
       values ($1, 'Escavatore', 'machine', 4000) returning id`,
      [id],
    )
    const report = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status)
       values ($1, $2, $3, 'approved') returning id`,
      [id, site('In ritardo'), today],
    )
    await ctx.owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 4, 0)`,
      [id, report.rows[0]?.id, worker.rows[0]?.id],
    )
    await ctx.owner.query(
      `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
       values ($1, $2, $3, 1.5, 0)`,
      [id, report.rows[0]?.id, vehicle.rows[0]?.id],
    )
    // «In ritardo»: a finished 10-day activity at 50% and a future 10-day one: 25% done,
    // 50% expected. «In anticipo»: one 4-day activity from yesterday at 100%: 50% expected.
    await ctx.owner.query(
      `insert into public.site_activities (company_id, site_id, name, start_on, end_on, progress)
       values ($1, $2, 'Scavi', $4, $5, 50), ($1, $2, 'Getti', $6, $7, 0),
         ($1, $3, 'Tetto', $8, $9, 100), ($1, $10, 'Ferma', $4, $5, 0)`,
      [
        id,
        site('In ritardo'),
        site('In anticipo'),
        await day(-20),
        await day(-11),
        await day(5),
        await day(14),
        await day(-1),
        await day(2),
        site('Sospeso'),
      ],
    )

    const d = (await s.browser.call('GET', s.url)).json<Dashboard>()
    expect(d.costs_by_month).toHaveLength(12)
    expect(d.costs_by_month?.[0]?.month).toBe(months.first.slice(0, 7))
    expect(d.costs_by_month?.[11]).toEqual({
      month: months.month,
      labor: '100.00',
      vehicles: '60.00',
      other: '10.00',
      total: '170.00',
    })
    // The cost of 11 months ago is in; the one of 12 months ago is not.
    expect(d.costs_by_month?.[0]).toMatchObject({ other: '2.50', total: '2.50' })
    expect(d.costs_by_month?.slice(1, 11).every((x) => x.total === '0.00')).toBe(true)
    expect(d.site_progress?.map((x) => [x.site.name, x.activities, x.progress, x.planned])).toEqual(
      [
        ['In ritardo', 2, 25, 50],
        ['In anticipo', 1, 100, 50],
      ],
    )

    const noCosts = await scene(['sites.view'])
    const e = (await noCosts.browser.call('GET', noCosts.url)).json<Dashboard>()
    expect(e.costs_by_month).toBeNull()
    expect(e.site_progress).toEqual([])
    const noSites = await scene(['costs.view'])
    expect((await noSites.browser.call('GET', noSites.url)).json<Dashboard>().site_progress).toBe(
      null,
    )
  })

  it('sums unpaid invoices by amount due, and what is overdue, without other companies', async () => {
    const s = await scene()
    const other = await scene()
    const empty = (await s.browser.call('GET', s.url)).json<Dashboard>()
    expect(empty.invoices).toEqual({
      receivable: '0.00',
      receivable_overdue: '0.00',
      payable: '0.00',
      payable_overdue: '0.00',
      payable_without_order: 0,
      payable_without_order_amount: '0.00',
    })
    for (const company of [s.company.id, other.company.id]) {
      await ctx.owner.query(
        `with c as (insert into public.clients (company_id, kind, name)
                    values ($1, 'person', 'Cliente') returning id),
              p as (insert into public.suppliers (company_id, name)
                    values ($1, 'Fornitore') returning id)
         insert into public.invoices (company_id, direction, number, invoice_date, client_id,
           supplier_id, taxable_cents, vat_cents, withholding_cents, split_payment, due_date,
           paid_on)
         select $1, x.direction, x.number, current_date - 60,
           case when x.direction = 'issued' then (select id from c) end,
           case when x.direction = 'received' then (select id from p) end,
           x.taxable, x.vat, x.withholding, x.split, current_date + x.due, x.paid
         from (values
           ('issued', '1', 100000::bigint, 22000::bigint, 0::bigint, false, -1, null::date),
           ('issued', '2', 50000, 11000, 0, true, 10, null),
           ('issued', '3', 99900, 0, 0, false, -5, current_date),
           ('received', 'A', 10000, 2200, 2000, false, -1, null),
           ('received', 'B', 30000, 6600, 0, false, null, null)
         ) as x (direction, number, taxable, vat, withholding, split, due, paid)`,
        [company],
      )
    }
    const d = (await s.browser.call('GET', s.url)).json<Dashboard>()
    // 1220 + 500 (split payment: no VAT); the paid one is left out.
    expect(d.invoices).toEqual({
      receivable: '1720.00',
      receivable_overdue: '1220.00',
      payable: '468.00',
      payable_overdue: '102.00',
      payable_without_order: 2,
      payable_without_order_amount: '468.00',
    })
  })

  it('counts unpaid received invoices without an order, as the register filter does', async () => {
    const s = await scene()
    const id = s.company.id
    await ctx.owner.query(
      `with p as (insert into public.suppliers (company_id, name)
                  values ($1, 'Fornitore') returning id),
            o as (insert into public.purchase_orders (company_id, number_year, number_seq,
                    supplier_id, order_date, status, sent_at)
                  select $1, 2026, 1, id, current_date, 'sent', now() from p returning id)
       insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         taxable_cents, vat_cents, purchase_order_id, paid_on)
       select $1, 'received', x.number, current_date, (select id from p), x.taxable, 0,
         case when x.linked then (select id from o) end, x.paid
       from (values
         ('A', 10, false, null::date),
         ('B', 20, false, null),
         ('C', 40000, true, null),
         ('D', 80000, false, current_date)
       ) as x (number, taxable, linked, paid)`,
      [id],
    )
    const d = (await s.browser.call('GET', s.url)).json<Dashboard>()
    // 0.10 + 0.20: the one with an order and the paid one are left out.
    expect(d.invoices).toMatchObject({
      payable: '400.30',
      payable_without_order: 2,
      payable_without_order_amount: '0.30',
    })
    const list = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/invoices?filter[direction]=received&filter[has_purchase_order]=false&filter[status]=open`,
    )
    expect(list.statusCode).toBe(200)
    expect(list.json<{ meta: { total: number } }>().meta.total).toBe(2)
  })

  it('counts active sites without a report today, whatever its status', async () => {
    const s = await scene(['sites.view', 'reports.view'])
    const id = s.company.id
    const sites = await ctx.owner.query<{ id: string; name: string }>(
      `insert into public.sites (company_id, name, status) values
         ($1, 'Senza', 'active'), ($1, 'Ieri', 'active'), ($1, 'Inviato', 'active'),
         ($1, 'Approvato', 'active'), ($1, 'Domani', 'active'), ($1, 'Sospeso', 'suspended'),
         ($1, 'Previsto', 'planned'), ($1, 'Chiuso', 'completed')
       returning id, name`,
      [id],
    )
    const site = (name: string) => sites.rows.find((r) => r.name === name)?.id
    await ctx.owner.query(
      `insert into public.daily_reports (company_id, site_id, report_date, status) values
         ($1, $2, $3, 'draft'), ($1, $4, $5, 'submitted'), ($1, $6, $5, 'approved'),
         ($1, $7, $8, 'draft')`,
      [
        id,
        site('Ieri'),
        await day(-1),
        site('Inviato'),
        await day(0),
        site('Approvato'),
        site('Domani'),
        await day(1),
      ],
    )
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    // Senza, Ieri and Domani: suspended, planned and completed sites do not count.
    expect(res.json<Dashboard>().reports).toEqual({
      to_approve: 1,
      drafts: 1,
      missing_today: 3,
      missing_week: 2,
    })

    // Without sites.view the count of sites stays hidden; the reports do not.
    const reportsOnly = await scene(['reports.view'])
    const r = (await reportsOnly.browser.call('GET', reportsOnly.url)).json<Dashboard>()
    expect(r.reports).toEqual({ to_approve: 0, drafts: 0, missing_today: null, missing_week: null })
  })

  it('leaves out the sections the user may not see, and other companies', async () => {
    const s = await scene(['deadlines.view'])
    const d = (await s.browser.call('GET', s.url)).json<Dashboard>()
    expect(d.sites).toBeNull()
    expect(d.over_budget).toBeNull()
    expect(d.costs_this_month).toBeNull()
    expect(d.reports).toBeNull()
    expect(d.invoices).toBeNull()
    expect(d.deadlines).toEqual([])
    const sitesOnly = await scene(['sites.view'])
    const e = (await sitesOnly.browser.call('GET', sitesOnly.url)).json<Dashboard>()
    expect(e.sites).not.toBeNull()
    expect(e.over_budget).toBeNull()

    const other = await scene()
    const foreign = await ctx.owner.query<{ id: string }>(
      "insert into public.sites (company_id, name, status) values ($1, 'Altrui', 'active') returning id",
      [other.company.id],
    )
    await ctx.owner.query(
      `insert into public.site_activities (company_id, site_id, name, start_on, end_on)
       values ($1, $2, 'Altrui', current_date, current_date)`,
      [other.company.id, foreign.rows[0]?.id],
    )
    await ctx.owner.query(
      `insert into public.site_costs (company_id, site_id, cost_date, category, description,
         amount_cents) values ($1, $2, current_date, 'materials', 'altrui', 5000)`,
      [other.company.id, foreign.rows[0]?.id],
    )
    expect((await s.browser.call('GET', other.url)).statusCode).toBe(404)
    const mine = await scene()
    expect((await mine.browser.call('GET', mine.url)).json<Dashboard>().sites).toEqual({
      planned: 0,
      active: 0,
      suspended: 0,
      completed: 0,
      without_prior_notice: 0,
      past_end: 0,
      ending_soon: 0,
      start_due: 0,
      without_team: 0,
      without_permit: 0,
      without_safety_coordinator: 0,
      without_works_director: 0,
    })
    const mineNow = (await mine.browser.call('GET', mine.url)).json<Dashboard>()
    expect(mineNow.site_progress).toEqual([])
    expect(mineNow.reports?.missing_today).toBe(0)
    expect(mineNow.costs_by_month?.every((x) => x.total === '0.00')).toBe(true)
    expect((await new Browser(ctx.app).call('GET', mine.url)).statusCode).toBe(401)
  })
})
