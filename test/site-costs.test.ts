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
  'costs.view',
  'costs.create',
  'costs.update',
  'costs.delete',
  'sites.delete',
  'suppliers.delete',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Costi', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1'),
       ($1, 'Condominio', null) returning id`,
    [company.id],
  )
  const supplier = await ctx.owner.query<{ id: string }>(
    "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
    [company.id],
  )
  return {
    browser,
    company,
    site: sites.rows[0]?.id ?? '',
    other: sites.rows[1]?.id ?? '',
    supplier: supplier.rows[0]?.id ?? '',
    base: `/api/companies/${company.slug}/costs`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const input = (s: Scene, overrides: Record<string, unknown> = {}) => ({
  site_id: s.site,
  date: '2026-11-04',
  category: 'materials',
  description: 'Calcestruzzo',
  supplier_id: s.supplier,
  amount: '1560.5',
  notes: null,
  ...overrides,
})

describe('site costs', () => {
  it('exports the costs as CSV with the same filters', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, { body: input(s) })
    await s.browser.call('POST', s.base, {
      body: input(s, {
        site_id: s.other,
        date: '2026-11-05',
        category: 'rentals',
        description: 'Nolo; gru',
        supplier_id: null,
        amount: '20',
        notes: 'storno',
      }),
    })
    const url = `${s.base}/export`
    const res = await s.browser.call('GET', `${url}?sort=date`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="costi.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toEqual([
      'Data;Cantiere;Codice cantiere;Categoria;Descrizione;Fornitore;Importo;Note',
      '04/11/2026;Villetta;C-1;Materiali;Calcestruzzo;Calcestruzzi Srl;1560,50;',
      '05/11/2026;Condominio;;Noli;"Nolo; gru";;20,00;storno',
    ])
    const filtered = await s.browser.call('GET', `${url}?filter[site]=${s.site}`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?sort=costo`)).statusCode).toBe(422)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('creates, reads, updates and deletes a cost with If-Match', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, { body: input(s) })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const cost = created.json<{ id: string }>()
    expect(cost).toMatchObject({
      amount: '1560.50',
      site: { id: s.site, name: 'Villetta', code: 'C-1' },
      supplier: { id: s.supplier, name: 'Calcestruzzi Srl' },
      category: 'materials',
      date: '2026-11-04',
    })
    const url = `${s.base}/${cost.id}`
    expect((await s.browser.call('GET', url)).json()).toEqual(cost)
    expect((await s.browser.call('PUT', url, { body: input(s) })).statusCode).toBe(428)
    const updated = await s.browser.call('PUT', url, {
      body: input(s, { supplier_id: null, category: 'other', amount: '10' }),
      headers: { 'If-Match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ supplier: null, amount: '10.00', category: 'other' })
    const stale = await s.browser.call('PUT', url, {
      body: input(s),
      headers: { 'If-Match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('validates the fields and the references', async () => {
    const s = await scene()
    const bad = await s.browser.call('POST', s.base, {
      body: input(s, { amount: '-5', category: 'cibo', description: ' ', date: '04/11/2026' }),
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'amount',
      'category',
      'date',
      'description',
    ])
    const foreign = await scene()
    const unknown = await s.browser.call('POST', s.base, {
      body: input(s, { site_id: foreign.site, supplier_id: foreign.supplier }),
    })
    expect(unknown.statusCode).toBe(422)
    expect(Object.keys(unknown.json<{ errors: object }>().errors).sort()).toEqual([
      'site_id',
      'supplier_id',
    ])
  })

  it('lists with filters and the total of all matching costs', async () => {
    const s = await scene()
    for (const body of [
      input(s),
      input(s, { date: '2026-11-01', amount: '100', supplier_id: null, category: 'rentals' }),
      input(s, { site_id: s.other, date: '2026-11-02', amount: '0.25' }),
    ]) {
      expect((await s.browser.call('POST', s.base, { body })).statusCode).toBe(201)
    }
    type List = { data: { date: string }[]; meta: { total: number }; total_amount: string }
    const all = (await s.browser.call('GET', `${s.base}?per_page=1`)).json<List>()
    expect(all.data.map((c) => c.date)).toEqual(['2026-11-04'])
    expect(all.meta.total).toBe(3)
    expect(all.total_amount).toBe('1660.75')
    const site = (await s.browser.call('GET', `${s.base}?filter[site]=${s.site}`)).json<List>()
    expect(site.total_amount).toBe('1660.50')
    const filtered = await s.browser.call(
      'GET',
      `${s.base}?filter[category]=materials&filter[supplier]=${s.supplier}&filter[from]=2026-11-03&sort=amount`,
    )
    expect(filtered.json<List>().meta.total).toBe(1)
    expect((await s.browser.call('GET', `${s.base}?filter[category]=x`)).statusCode).toBe(422)

    // A site or supplier with costs cannot be deleted.
    for (const path of [`sites/${s.site}`, `suppliers/${s.supplier}`]) {
      const res = await s.browser.call('DELETE', `/api/companies/${s.company.slug}/${path}`, {
        headers: { 'If-Match': '"1"' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'has_documents' })
    }
  })

  it('needs the costs permissions', async () => {
    const owner = await scene()
    const created = await owner.browser.call('POST', owner.base, { body: input(owner) })
    const url = `${owner.base}/${created.json<{ id: string }>().id}`
    const reader = await fx.user()
    const role = await fx.role(owner.company.id, 'Lettura', ['costs.view'])
    await fx.member(reader.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.email)
    expect((await browser.call('GET', url)).statusCode).toBe(200)
    expect((await browser.call('POST', owner.base, { body: input(owner) })).statusCode).toBe(403)
    const headers = { 'If-Match': '"1"' }
    expect((await browser.call('PUT', url, { body: input(owner), headers })).statusCode).toBe(403)
    expect((await browser.call('DELETE', url, { headers })).statusCode).toBe(403)
    const none = await scene(['clients.view'])
    expect((await none.browser.call('GET', none.base)).statusCode).toBe(403)
    expect(
      (await none.browser.call('GET', `${none.base}/${created.json<{ id: string }>().id}`))
        .statusCode,
    ).toBe(404)
  })

  it('summarizes approved report hours at hourly cost and manual costs against the budget', async () => {
    const s = await scene()
    const summary = `/api/companies/${s.company.slug}/sites/${s.site}/cost-summary`
    await ctx.owner.query('update public.sites set budget_cents = 100000 where id = $1', [s.site])
    const empty = await s.browser.call('GET', summary)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toMatchObject({
      labor: { hours: '0.00', amount: '0.00' },
      total: '0.00',
      budget: '1000.00',
      budget_remaining: '1000.00',
      over_budget: false,
      missing_hourly_costs: 0,
    })
    const people = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
       values ($1, 'Luca', 'Verdi', 2850), ($1, 'Anna', 'Bassi', null) returning id`,
      [s.company.id],
    )
    const machine = await ctx.owner.query<{ id: string }>(
      `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
       values ($1, 'Escavatore', 'machine', 4500) returning id`,
      [s.company.id],
    )
    const reports = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status)
       values ($1, $2, '2026-11-02', 'approved'), ($1, $2, '2026-11-03', 'submitted')
       returning id`,
      [s.company.id, s.site],
    )
    for (const report of reports.rows) {
      await ctx.owner.query(
        `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
         values ($1, $2, $3, 7.5, 0), ($1, $2, $4, 8, 1)`,
        [s.company.id, report.id, people.rows[0]?.id, people.rows[1]?.id],
      )
      await ctx.owner.query(
        `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
         values ($1, $2, $3, 2.25, 0)`,
        [s.company.id, report.id, machine.rows[0]?.id],
      )
    }
    await s.browser.call('POST', s.base, { body: input(s, { amount: '900' }) })
    await s.browser.call('POST', s.base, { body: input(s, { amount: '50', category: 'rentals' }) })
    await s.browser.call('POST', s.base, { body: input(s, { site_id: s.other, amount: '7' }) })
    const res = await s.browser.call('GET', summary)
    // Only the approved report: 7.5 h × 28.50 = 213.75 (Bassi has no rate), 2.25 h × 45 = 101.25.
    expect(res.json()).toEqual({
      site: { id: s.site, name: 'Villetta', code: 'C-1' },
      labor: { hours: '15.50', amount: '213.75' },
      vehicles: { hours: '2.25', amount: '101.25' },
      materials: '900.00',
      rentals: '50.00',
      subcontract: '0.00',
      other: '0.00',
      total: '1265.00',
      budget: '1000.00',
      budget_remaining: '-265.00',
      over_budget: true,
      missing_hourly_costs: 1,
      revenue: null,
    })
    const foreign = await scene()
    expect(
      (await foreign.browser.call('GET', summary.replace(s.company.slug, foreign.company.slug)))
        .statusCode,
    ).toBe(404)
    const reader = await scene(['clients.view'])
    expect(
      (await reader.browser.call('GET', summary.replace(s.company.slug, reader.company.slug)))
        .statusCode,
    ).toBe(404)
  })

  it('shows invoiced revenue and margin only with invoices.view', async () => {
    const s = await scene([...ALL, 'invoices.view'])
    const summary = `/api/companies/${s.company.slug}/sites/${s.site}/cost-summary`
    const empty = await s.browser.call('GET', summary)
    expect(empty.json()).toMatchObject({
      total: '0.00',
      revenue: { invoiced: '0.00', margin: '0.00', certified: null, certified_uninvoiced: null },
    })
    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Rossi') returning id",
      [s.company.id],
    )
    // Issued on this site (paid or not) count; received ones and other sites do not.
    await ctx.owner.query(
      `insert into public.invoices
         (company_id, direction, number, invoice_date, client_id, supplier_id, site_id,
          taxable_cents, vat_cents, paid_on)
       values ($1, 'issued', '1', '2026-11-02', $2, null, $4, 50000, 11000, null),
              ($1, 'issued', '2', '2026-11-03', $2, null, $4, 25050, 0, '2026-11-04'),
              ($1, 'issued', '3', '2026-11-03', $2, null, $5, 99900, 0, null),
              ($1, 'received', 'F-9', '2026-11-03', null, $3, $4, 70000, 15400, null)`,
      [s.company.id, client.rows[0]?.id, s.supplier, s.site, s.other],
    )
    await s.browser.call('POST', s.base, { body: input(s, { amount: '900' }) })
    const res = await s.browser.call('GET', summary)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      total: '900.00',
      revenue: { invoiced: '750.50', margin: '-149.50' },
    })
    const blind = await scene(ALL)
    const other = await blind.browser.call(
      'GET',
      `/api/companies/${blind.company.slug}/sites/${blind.site}/cost-summary`,
    )
    expect(other.json()).toMatchObject({ revenue: null })
  })

  it('shows approved progress statements and those not invoiced yet with estimates.view', async () => {
    const s = await scene([...ALL, 'invoices.view', 'estimates.view'])
    const summary = `/api/companies/${s.company.slug}/sites/${s.site}/cost-summary`
    const q = (sql: string, params: unknown[]) =>
      ctx.owner.query<{ id: string }>(sql, params).then((r) => r.rows[0]?.id ?? '')
    const client = await q(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Rossi') returning id",
      [s.company.id],
    )
    // Approved statements of this site's estimate: 100 (invoiced) and 30.25 (not yet);
    // a draft and the statements of another site's estimate do not count.
    const statement = async (site: string, status: string, number: number, qty: string) => {
      const estimate = await q(
        "insert into public.estimates (company_id, title, site_id) values ($1, 'C', $2) returning id",
        [s.company.id, site],
      )
      const chapter = await q(
        `insert into public.estimate_chapters (company_id, estimate_id, title, position)
         values ($1, $2, 'Opere', 0) returning id`,
        [s.company.id, estimate],
      )
      const item = await q(
        `insert into public.estimate_items
           (company_id, estimate_id, chapter_id, description, unit, unit_price_cents, position)
         values ($1, $2, $3, 'Massetto', 'm²', 1000, 0) returning id`,
        [s.company.id, estimate, chapter],
      )
      const id = await q(
        `insert into public.progress_statements
           (company_id, estimate_id, number, statement_date, status, approved_at)
         values ($1, $2, $3, '2026-11-30', $4, case when $4 = 'approved' then now() end)
         returning id`,
        [s.company.id, estimate, number, status],
      )
      await ctx.owner.query(
        `insert into public.progress_statement_lines
           (company_id, estimate_id, statement_id, item_id, quantity, unit_price_cents)
         values ($1, $2, $3, $4, $5, 1000)`,
        [s.company.id, estimate, id, item, qty],
      )
      return id
    }
    const billed = await statement(s.site, 'approved', 1, '10')
    await statement(s.site, 'approved', 1, '3.025')
    await statement(s.site, 'draft', 1, '50')
    await statement(s.other, 'approved', 1, '70')
    await ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
         site_id, taxable_cents, vat_cents, progress_statement_id)
       values ($1, 'issued', '1', '2026-11-30', $2, $3, 10000, 0, $4)`,
      [s.company.id, client, s.site, billed],
    )
    const res = await s.browser.call('GET', summary)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      revenue: {
        invoiced: '100.00',
        margin: '100.00',
        certified: '130.25',
        certified_uninvoiced: '30.25',
      },
    })
  })
})
