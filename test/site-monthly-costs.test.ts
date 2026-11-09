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

interface Month {
  month: string
  labor: string
  vehicles: string
  other: string
  total: string
  cumulative: string
  invoiced: string | null
  cumulative_invoiced: string | null
}
interface MonthlyCosts {
  budget: string | null
  months: Month[]
}

async function scene(permissions: Permission[] = ['costs.view']) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Costi', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, status, budget_cents) values
       ($1, 'Villetta', 'active', 50000), ($1, 'Box', 'planned', null)
     returning id`,
    [company.id],
  )
  const [villetta, box] = sites.rows.map((r) => r.id)
  const person = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2850) returning id`,
    [company.id],
  )
  const machine = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', 4500) returning id`,
    [company.id],
  )
  // August: approved report on the last day; September: only a submitted report (not counted);
  // November: approved report on the first day.
  const reports = await ctx.owner.query<{ id: string }>(
    `insert into public.daily_reports (company_id, site_id, report_date, status) values
       ($1, $2, '2026-08-31', 'approved'), ($1, $2, '2026-09-15', 'submitted'),
       ($1, $2, '2026-11-01', 'approved')
     returning id`,
    [company.id, villetta],
  )
  for (const report of reports.rows) {
    await ctx.owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 7.5, 0)`,
      [company.id, report.id, person.rows[0]?.id],
    )
    await ctx.owner.query(
      `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
       values ($1, $2, $3, 2.25, 0)`,
      [company.id, report.id, machine.rows[0]?.id],
    )
  }
  await ctx.owner.query(
    `insert into public.site_costs (company_id, site_id, cost_date, category, description, amount_cents)
     values ($1, $2, '2026-08-01', 'materials', 'Sabbia', 10),
       ($1, $2, '2026-08-31', 'rentals', 'Nolo', 20),
       ($1, $2, '2026-11-30', 'subcontract', 'Impianti', 125000)`,
    [company.id, villetta],
  )
  return {
    browser,
    company,
    villetta: villetta ?? '',
    box: box ?? '',
    url: (site: string) => `/api/companies/${company.slug}/sites/${site}/cost-summary/months`,
  }
}

describe('site monthly costs', () => {
  it('gives every month from the first to the last cost, with the running total', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.url(s.villetta))
    expect(res.statusCode).toBe(200)
    // Labour 7.5 × 28.50 = 213.75, vehicles 2.25 × 45.00 = 101.25 per approved report.
    expect(res.json<MonthlyCosts>()).toEqual({
      budget: '500.00',
      months: [
        {
          month: '2026-08',
          labor: '213.75',
          vehicles: '101.25',
          other: '0.30',
          total: '315.30',
          cumulative: '315.30',
          invoiced: null,
          cumulative_invoiced: null,
        },
        {
          month: '2026-09',
          labor: '0.00',
          vehicles: '0.00',
          other: '0.00',
          total: '0.00',
          cumulative: '315.30',
          invoiced: null,
          cumulative_invoiced: null,
        },
        {
          month: '2026-10',
          labor: '0.00',
          vehicles: '0.00',
          other: '0.00',
          total: '0.00',
          cumulative: '315.30',
          invoiced: null,
          cumulative_invoiced: null,
        },
        {
          month: '2026-11',
          labor: '213.75',
          vehicles: '101.25',
          other: '1250.00',
          total: '1565.00',
          cumulative: '1880.30',
          invoiced: null,
          cumulative_invoiced: null,
        },
      ],
    })
    const summary = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.villetta}/cost-summary`,
    )
    expect(summary.json<{ total: string }>().total).toBe('1880.30')
  })

  it('adds the invoiced amount per month with invoices.view', async () => {
    const s = await scene(['costs.view', 'invoices.view'])
    const client = await ctx.owner.query<{ id: string }>(
      `insert into public.clients (company_id, kind, name) values ($1, 'person', 'Committente') returning id`,
      [s.company.id],
    )
    const supplier = await ctx.owner.query<{ id: string }>(
      `insert into public.suppliers (company_id, name) values ($1, 'Fornitore') returning id`,
      [s.company.id],
    )
    // July, before the first cost: it opens the list. November: 0.10 + 0.20. A received
    // invoice on the site and an issued one on another site do not count.
    await ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
         supplier_id, site_id, taxable_cents, vat_cents)
       values ($1, 'issued', '1', '2026-07-31', $2, null, $4, 100000, 22000),
         ($1, 'issued', '2', '2026-11-01', $2, null, $4, 10, 2),
         ($1, 'issued', '3', '2026-11-30', $2, null, $4, 20, 4),
         ($1, 'received', 'R/1', '2026-11-10', null, $3, $4, 70000, 15400),
         ($1, 'issued', '4', '2026-12-01', $2, null, $5, 99999, 0)`,
      [s.company.id, client.rows[0]?.id, supplier.rows[0]?.id, s.villetta, s.box],
    )
    const months = (await s.browser.call('GET', s.url(s.villetta))).json<MonthlyCosts>().months
    expect(months.map((m) => [m.month, m.total, m.invoiced, m.cumulative_invoiced])).toEqual([
      ['2026-07', '0.00', '1000.00', '1000.00'],
      ['2026-08', '315.30', '0.00', '1000.00'],
      ['2026-09', '0.00', '0.00', '1000.00'],
      ['2026-10', '0.00', '0.00', '1000.00'],
      ['2026-11', '1565.00', '0.30', '1000.30'],
    ])
    expect(months.at(-1)?.cumulative).toBe('1880.30')
    const summary = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.villetta}/cost-summary`,
    )
    expect(summary.json<{ revenue: { invoiced: string } }>().revenue.invoiced).toBe('1000.30')
    // A site with only invoices has months too.
    const box = (await s.browser.call('GET', s.url(s.box))).json<MonthlyCosts>().months
    expect(box).toEqual([
      {
        month: '2026-12',
        labor: '0.00',
        vehicles: '0.00',
        other: '0.00',
        total: '0.00',
        cumulative: '0.00',
        invoiced: '999.99',
        cumulative_invoiced: '999.99',
      },
    ])
  })

  it('has no months for a site without costs', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.url(s.box))
    expect(res.statusCode).toBe(200)
    expect(res.json<MonthlyCosts>()).toEqual({ budget: null, months: [] })
  })

  it('answers 404 without costs.view, for an unknown site and across companies', async () => {
    const s = await scene()
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', blind.url(blind.villetta))).statusCode).toBe(404)
    expect((await s.browser.call('GET', s.url('not-an-id'))).statusCode).toBe(404)
    expect(
      (await s.browser.call('GET', s.url('00000000-0000-4000-8000-000000000000'))).statusCode,
    ).toBe(404)
    // Another company's site, asked through one's own company: not visible.
    expect((await s.browser.call('GET', s.url(blind.villetta))).statusCode).toBe(404)
    // Another company's slug: not a member.
    expect((await s.browser.call('GET', blind.url(blind.villetta))).statusCode).toBe(404)
  })

  it('needs a session', async () => {
    const s = await scene()
    const res = await new Browser(ctx.app).call('GET', s.url(s.villetta))
    expect(res.statusCode).toBe(401)
  })
})
