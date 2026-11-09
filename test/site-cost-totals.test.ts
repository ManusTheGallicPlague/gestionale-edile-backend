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

const ALL: Permission[] = ['costs.view', 'sites.view']

interface Total {
  site: { id: string; name: string; code: string | null; status: string }
  labor: string
  vehicles: string
  manual: string
  total: string
  period_total: string | null
  budget: string | null
  budget_remaining: string | null
  over_budget: boolean
}
interface TotalList {
  data: Total[]
  meta: { total: number; page: number; per_page: number }
  total_amount: string
  period_total_amount: string | null
  budget_amount: string
}

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Costi', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, code, status, budget_cents) values
       ($1, 'Villetta', 'C-1', 'active', 30000),
       ($1, 'Condominio', null, 'active', 100000),
       ($1, 'Capannone', 'C-3', 'completed', null),
       ($1, 'Box; auto', null, 'planned', 0)
     returning id`,
    [company.id],
  )
  const [villetta, condominio, capannone, box] = sites.rows.map((r) => r.id)
  const person = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2850), ($1, 'Anna', 'Bassi', null) returning id`,
    [company.id],
  )
  const machine = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', 4500) returning id`,
    [company.id],
  )
  const reports = await ctx.owner.query<{ id: string }>(
    `insert into public.daily_reports (company_id, site_id, report_date, status)
     values ($1, $2, '2026-11-02', 'approved'), ($1, $2, '2026-11-03', 'submitted')
     returning id`,
    [company.id, villetta],
  )
  for (const report of reports.rows) {
    await ctx.owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 7.5, 0), ($1, $2, $4, 8, 1)`,
      [company.id, report.id, person.rows[0]?.id, person.rows[1]?.id],
    )
    await ctx.owner.query(
      `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
       values ($1, $2, $3, 2.25, 0)`,
      [company.id, report.id, machine.rows[0]?.id],
    )
  }
  // Labour 213.75 + vehicles 101.25 + by hand 0.10 and 0.20 on the Villetta: 315.30, over 300.
  await ctx.owner.query(
    `insert into public.site_costs (company_id, site_id, cost_date, category, description, amount_cents)
     values ($1, $2, '2026-11-04', 'materials', 'Sabbia', 10),
       ($1, $2, '2026-11-05', 'rentals', 'Nolo', 20),
       ($1, $3, '2026-11-05', 'subcontract', 'Impianti', 125000),
       ($1, $4, '2026-11-06', 'other', 'Pulizia', 999)`,
    [company.id, villetta, condominio, capannone],
  )
  return {
    browser,
    company,
    villetta: villetta ?? '',
    condominio: condominio ?? '',
    capannone: capannone ?? '',
    box: box ?? '',
    base: `/api/companies/${company.slug}/site-costs/totals`,
  }
}

describe('site cost totals', () => {
  it('lists every site with its costs against the budget, as the cost summary', async () => {
    const s = await scene([...ALL, 'reports.view'])
    const res = await s.browser.call('GET', s.base)
    expect(res.statusCode).toBe(200)
    const list = res.json<TotalList>()
    expect(list.meta).toEqual({ total: 4, page: 1, per_page: 25 })
    expect(list.data.map((t) => t.site.name)).toEqual([
      'Box; auto',
      'Capannone',
      'Condominio',
      'Villetta',
    ])
    expect(list.data[3]).toEqual({
      site: { id: s.villetta, name: 'Villetta', code: 'C-1', status: 'active' },
      labor: '213.75',
      vehicles: '101.25',
      manual: '0.30',
      total: '315.30',
      period_total: null,
      budget: '300.00',
      budget_remaining: '-15.30',
      over_budget: true,
    })
    expect(list.period_total_amount).toBeNull()
    expect(list.data[0]).toMatchObject({
      total: '0.00',
      budget: '0.00',
      budget_remaining: '0.00',
      over_budget: false,
    })
    expect(list.data[1]).toMatchObject({
      total: '9.99',
      budget: null,
      budget_remaining: null,
      over_budget: false,
    })
    expect(list.total_amount).toBe('1575.29')
    expect(list.budget_amount).toBe('1300.00')
    for (const row of list.data) {
      const summary = await s.browser.call(
        'GET',
        `/api/companies/${s.company.slug}/sites/${row.site.id}/cost-summary`,
      )
      expect(summary.json()).toMatchObject({
        total: row.total,
        budget: row.budget,
        budget_remaining: row.budget_remaining,
        over_budget: row.over_budget,
      })
    }
  })

  it('filters, sorts and pages', async () => {
    const s = await scene()
    const names = async (query: string) =>
      (await s.browser.call('GET', `${s.base}?${query}`))
        .json<TotalList>()
        .data.map((t) => t.site.name)
    expect(await names('filter[over_budget]=true')).toEqual(['Condominio', 'Villetta'])
    expect(await names('filter[over_budget]=false')).toEqual(['Box; auto', 'Capannone'])
    expect(await names('filter[status]=active&filter[over_budget]=true&sort=-name')).toEqual([
      'Villetta',
      'Condominio',
    ])
    expect(await names('filter[status]=completed')).toEqual(['Capannone'])
    expect(await names('sort=-total')).toEqual(['Condominio', 'Villetta', 'Capannone', 'Box; auto'])
    expect(await names('sort=total')).toEqual(['Box; auto', 'Capannone', 'Villetta', 'Condominio'])
    // Without a budget the site goes last both ways.
    expect(await names('sort=remaining')).toEqual([
      'Condominio',
      'Villetta',
      'Box; auto',
      'Capannone',
    ])
    expect(await names('sort=-remaining')).toEqual([
      'Box; auto',
      'Villetta',
      'Condominio',
      'Capannone',
    ])
    const page = await s.browser.call('GET', `${s.base}?per_page=1&page=2&sort=-total`)
    const paged = page.json<TotalList>()
    expect(paged.data.map((t) => t.site.name)).toEqual(['Villetta'])
    expect(paged.meta).toEqual({ total: 4, page: 2, per_page: 1 })
    expect(paged.total_amount).toBe('1575.29')
    const over = await s.browser.call('GET', `${s.base}?filter[over_budget]=true`)
    expect(over.json<TotalList>()).toMatchObject({
      total_amount: '1565.30',
      budget_amount: '1300.00',
    })
    expect(await names('search=VILL')).toEqual(['Villetta'])
    expect(await names('search=c-3')).toEqual(['Capannone'])
    expect(await names('search=%25')).toEqual([])
    expect(await names('search=_')).toEqual([])
    expect(await names('search=c&filter[over_budget]=true')).toEqual(['Condominio', 'Villetta'])
    const searched = await s.browser.call('GET', `${s.base}?search=C-1`)
    expect(searched.json<TotalList>()).toMatchObject({
      meta: { total: 1 },
      total_amount: '315.30',
      budget_amount: '300.00',
    })
    const csv = await s.browser.call('GET', `${s.base}/export?search=box`)
    expect(csv.body.trim().split('\r\n')).toHaveLength(2)
    for (const query of [
      `search=${'a'.repeat(101)}`,
      'filter[over_budget]=si',
      'filter[status]=chiuso',
      'sort=budget',
      'per_page=101',
      'page=0',
    ]) {
      expect((await s.browser.call('GET', `${s.base}?${query}`)).statusCode).toBe(422)
    }
  })

  it('adds the cost of a period, both ends included, keeping the budget on the whole total', async () => {
    const s = await scene()
    const other = await scene()
    const read = async (query: string) => {
      const res = await s.browser.call('GET', `${s.base}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<TotalList>()
    }
    const periods = (list: TotalList) =>
      Object.fromEntries(list.data.map((t) => [t.site.name, t.period_total]))

    const week = await read('filter[from]=2026-11-04&filter[to]=2026-11-05')
    expect(periods(week)).toEqual({
      'Box; auto': '0.00',
      Capannone: '0.00',
      Condominio: '1250.00',
      Villetta: '0.30',
    })
    expect(week.period_total_amount).toBe('1250.30')
    // Budget, remaining and over_budget stay on the whole total, as without a period.
    expect(week.total_amount).toBe('1575.29')
    expect(week.data.find((t) => t.site.name === 'Villetta')).toMatchObject({
      total: '315.30',
      budget_remaining: '-15.30',
      over_budget: true,
    })

    // A single day: the approved report counts, the submitted one of the day after never does.
    const day = await read('filter[from]=2026-11-02&filter[to]=2026-11-02')
    expect(periods(day)['Villetta']).toBe('315.00')
    expect(day.period_total_amount).toBe('315.00')
    expect((await read('filter[to]=2026-11-03')).period_total_amount).toBe('315.00')
    const since = await read('filter[from]=2026-11-06')
    expect(periods(since)).toMatchObject({ Capannone: '9.99', Villetta: '0.00' })
    expect(since.period_total_amount).toBe('9.99')
    expect((await read('filter[from]=2026-12-01')).period_total_amount).toBe('0.00')

    // With the other filters the period sum covers only the sites found, on every page.
    const notOver = await read('filter[from]=2026-11-01&filter[over_budget]=false&per_page=1')
    expect(notOver.meta.total).toBe(2)
    expect(notOver.period_total_amount).toBe('9.99')
    expect((await read('filter[from]=2026-11-01&search=vill')).period_total_amount).toBe('315.30')

    // The other company has the same costs and does not change these sums.
    const theirs = await other.browser.call('GET', `${other.base}?filter[from]=2026-11-04`)
    expect(theirs.json<TotalList>().period_total_amount).toBe('1260.29')
    expect((await read('filter[from]=2026-11-04')).period_total_amount).toBe('1260.29')

    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=-total&filter[from]=2026-11-04&filter[to]=2026-11-05`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Cantiere;Codice;Stato;Manodopera;Mezzi;Costi inseriti;Totale;Budget;Residuo;Sopra budget;Costo del periodo',
      'Condominio;;In corso;0,00;0,00;1250,00;1250,00;1000,00;-250,00;Sì;1250,00',
      'Villetta;C-1;In corso;213,75;101,25;0,30;315,30;300,00;-15,30;Sì;0,30',
      'Capannone;C-3;Chiuso;0,00;0,00;9,99;9,99;;;No;0,00',
      '"Box; auto";;Da iniziare;0,00;0,00;0,00;0,00;0,00;0,00;No;0,00',
    ])

    for (const query of [
      'filter[from]=2026-13-01',
      'filter[to]=ieri',
      'filter[from]=2026-11-05&filter[to]=2026-11-04',
      'filter[from]=2026-11-01&filter[from]=2026-11-02',
    ]) {
      const res = await s.browser.call('GET', `${s.base}?${query}`)
      expect(res.statusCode).toBe(422)
      expect((await s.browser.call('GET', `${s.base}/export?${query}`)).statusCode).toBe(422)
    }
    const backwards = await s.browser.call(
      'GET',
      `${s.base}?filter[from]=2026-11-05&filter[to]=2026-11-04`,
    )
    expect(backwards.json<{ errors: Record<string, string[]> }>().errors).toHaveProperty(
      'filter[to]',
    )
  })

  it('exports the same list as CSV', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export?sort=-total`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="costi-cantieri.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Cantiere;Codice;Stato;Manodopera;Mezzi;Costi inseriti;Totale;Budget;Residuo;Sopra budget',
      'Condominio;;In corso;0,00;0,00;1250,00;1250,00;1000,00;-250,00;Sì',
      'Villetta;C-1;In corso;213,75;101,25;0,30;315,30;300,00;-15,30;Sì',
      'Capannone;C-3;Chiuso;0,00;0,00;9,99;9,99;;;No',
      '"Box; auto";;Da iniziare;0,00;0,00;0,00;0,00;0,00;0,00;No',
    ])
    const filtered = await s.browser.call('GET', `${s.base}/export?filter[over_budget]=false`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(3)
    expect((await s.browser.call('GET', `${s.base}/export?sort=costo`)).statusCode).toBe(422)
  })

  it('needs costs.view and sites.view and never shows another company', async () => {
    const s = await scene()
    const other = await scene()
    const res = await other.browser.call('GET', other.base)
    const ids = res.json<TotalList>().data.map((t) => t.site.id)
    expect(ids).not.toContain(s.villetta)
    expect(res.json<TotalList>().total_amount).toBe('1575.29')
    expect((await other.browser.call('GET', s.base)).statusCode).toBe(404)
    expect((await other.browser.call('GET', `${s.base}/export`)).statusCode).toBe(404)
    for (const permissions of [['costs.view'], ['sites.view']] as Permission[][]) {
      const blind = await scene(permissions)
      expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)
      expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    }
    expect((await new Browser(ctx.app).call('GET', s.base)).statusCode).toBe(401)
  })
})
