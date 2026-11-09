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

async function scene(permissions: Permission[] = ['sites.view', 'suppliers.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const supplierId = await supplier(company.id, 'Bianchi Scavi')
  return {
    browser,
    company,
    supplierId,
    url: `/api/companies/${company.slug}/suppliers/${supplierId}/sites`,
  }
}

async function supplier(companyId: string, name: string, archived = false) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.suppliers (company_id, name, subcontractor, archived_at)
     values ($1, $2, true, case when $3 then now() end) returning id`,
    [companyId, name, archived],
  )
  return rows[0]?.id ?? ''
}

async function site(companyId: string, name: string, status: string, code: string | null = null) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, status, code) values ($1, $2, $3, $4)
     returning id`,
    [companyId, name, status, code],
  )
  return rows[0]?.id ?? ''
}

async function cost(companyId: string, siteId: string, supplierId: string, cents = 987654) {
  await ctx.owner.query(
    `insert into public.site_costs (company_id, site_id, supplier_id, cost_date, category,
       description, amount_cents) values ($1, $2, $3, '2026-10-01', 'subcontract', 'x', $4)`,
    [companyId, siteId, supplierId, cents],
  )
}

async function order(companyId: string, siteId: string, supplierId: string) {
  await ctx.owner.query(
    `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
       site_id, order_date) values ($1, 2026, floor(random() * 1e6)::int + 1, $2, $3, '2026-10-01')`,
    [companyId, supplierId, siteId],
  )
}

describe('sites of a supplier', () => {
  it('lists the sites with a cost or an order of the supplier, in progress first', async () => {
    const { browser, company, supplierId, url } = await scene()
    const closed = await site(company.id, 'Arena', 'completed')
    const active = await site(company.id, 'Villetta', 'active', 'C-01')
    const planned = await site(company.id, 'Box', 'planned')
    const both = await site(company.id, 'Condominio', 'active')
    const suspended = await site(company.id, 'Scuola', 'suspended')
    const unrelated = await site(company.id, 'Niente', 'active')
    await cost(company.id, closed, supplierId)
    await cost(company.id, active, supplierId)
    await order(company.id, planned, supplierId)
    await cost(company.id, both, supplierId)
    await cost(company.id, both, supplierId)
    await order(company.id, both, supplierId)
    await order(company.id, suspended, supplierId)
    const other = await supplier(company.id, 'Altri')
    await cost(company.id, unrelated, other)

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { site_id: both, code: null, name: 'Condominio', status: 'active', costs: null },
        { site_id: active, code: 'C-01', name: 'Villetta', status: 'active', costs: null },
        { site_id: planned, code: null, name: 'Box', status: 'planned', costs: null },
        { site_id: suspended, code: null, name: 'Scuola', status: 'suspended', costs: null },
        { site_id: closed, code: null, name: 'Arena', status: 'completed', costs: null },
      ],
    })
    expect(res.body).not.toContain('9876')

    const empty = await browser.call('GET', url.replace(supplierId, other))
    expect(empty.json()).toEqual({
      data: [{ site_id: unrelated, code: null, name: 'Niente', status: 'active', costs: null }],
    })
  })

  it('adds the supplier costs on each site with costs.view', async () => {
    const { browser, company, supplierId, url } = await scene([
      'sites.view',
      'suppliers.view',
      'costs.view',
    ])
    const a = await site(company.id, 'Arena', 'active')
    const b = await site(company.id, 'Box', 'active')
    const c = await site(company.id, 'Casa', 'active')
    await cost(company.id, a, supplierId, 10)
    await cost(company.id, a, supplierId, 20)
    await cost(company.id, b, supplierId)
    await order(company.id, c, supplierId)
    const other = await supplier(company.id, 'Altri')
    await cost(company.id, a, other, 5000)
    await ctx.owner.query(
      `insert into public.site_costs (company_id, site_id, cost_date, category, description,
         amount_cents) values ($1, $2, '2026-10-01', 'other', 'senza fornitore', 7000)`,
      [company.id, a],
    )

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { site_id: a, code: null, name: 'Arena', status: 'active', costs: '0.30' },
        { site_id: b, code: null, name: 'Box', status: 'active', costs: '9876.54' },
        { site_id: c, code: null, name: 'Casa', status: 'active', costs: '0.00' },
      ],
    })

    // Same amount as the supplier's row in the cost summary by supplier of the site.
    const summary = await browser.call(
      'GET',
      `/api/companies/${company.slug}/sites/${a}/cost-summary/suppliers`,
    )
    const row = summary
      .json<{ suppliers: { supplier: { id: string } | null; total: string }[] }>()
      .suppliers.find((r) => r.supplier?.id === supplierId)
    expect(row?.total).toBe('0.30')
  })

  it('works for an archived supplier', async () => {
    const { browser, company } = await scene()
    const archived = await supplier(company.id, 'Archiviata', true)
    const s = await site(company.id, 'Villetta', 'completed')
    await order(company.id, s, archived)
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/suppliers/${archived}/sites`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [{ site_id: s, code: null, name: 'Villetta', status: 'completed', costs: null }],
    })
  })

  it('needs suppliers.view (404) and sites.view (403)', async () => {
    const office = await scene(['suppliers.view'])
    expect((await office.browser.call('GET', office.url)).statusCode).toBe(403)
    const chief = await scene(['sites.view'])
    expect((await chief.browser.call('GET', chief.url)).statusCode).toBe(404)
    const mine = await scene()
    expect(
      (await mine.browser.call('GET', mine.url.replace(mine.supplierId, 'nope'))).statusCode,
    ).toBe(404)
    expect(
      (
        await mine.browser.call(
          'GET',
          mine.url.replace(mine.supplierId, '00000000-0000-4000-8000-000000000000'),
        )
      ).statusCode,
    ).toBe(404)
    expect((await new Browser(ctx.app).call('GET', mine.url)).statusCode).toBe(401)
  })

  it('does not show another company’s supplier or sites', async () => {
    const mine = await scene()
    const theirs = await scene()
    const s = await site(theirs.company.id, 'Loro', 'active')
    await cost(theirs.company.id, s, theirs.supplierId)
    const other = `/api/companies/${mine.company.slug}/suppliers/${theirs.supplierId}/sites`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    const foreign = await theirs.browser.call('GET', theirs.url)
    expect(foreign.json()).toEqual({
      data: [{ site_id: s, code: null, name: 'Loro', status: 'active', costs: null }],
    })
    expect((await mine.browser.call('GET', mine.url)).json()).toEqual({ data: [] })
    // A cost of another company on a site of mine with my supplier's id does not count.
    const counted = await scene(['sites.view', 'suppliers.view', 'costs.view'])
    const own = await site(counted.company.id, 'Mio', 'active')
    await cost(counted.company.id, own, counted.supplierId, 100)
    const foreignSite = await site(theirs.company.id, 'Altro', 'active')
    await cost(theirs.company.id, foreignSite, theirs.supplierId, 999)
    expect((await counted.browser.call('GET', counted.url)).json()).toEqual({
      data: [{ site_id: own, code: null, name: 'Mio', status: 'active', costs: '1.00' }],
    })
  })
})
