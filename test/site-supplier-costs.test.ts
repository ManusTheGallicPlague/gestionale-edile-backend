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

interface SupplierCost {
  supplier: { id: string; name: string } | null
  costs: number
  materials: string
  rentals: string
  subcontract: string
  other: string
  total: string
}
interface SupplierCosts {
  total: string
  suppliers: SupplierCost[]
}

async function scene(permissions: Permission[] = ['costs.view']) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Costi', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, status) values
       ($1, 'Villetta', 'active'), ($1, 'Box', 'planned')
     returning id`,
    [company.id],
  )
  const [villetta = '', box = ''] = sites.rows.map((r) => r.id)
  const suppliers = await ctx.owner.query<{ id: string }>(
    `insert into public.suppliers (company_id, name, archived_at) values
       ($1, 'Noli Rossi', null), ($1, 'Calcestruzzi', null), ($1, 'Archiviato', now())
     returning id`,
    [company.id],
  )
  const [noli = '', calce = '', archived = ''] = suppliers.rows.map((r) => r.id)
  // Noli Rossi and Calcestruzzi both reach 15.00, so they are ordered by name.
  await ctx.owner.query(
    `insert into public.site_costs
       (company_id, site_id, cost_date, category, description, supplier_id, amount_cents)
     values ($1, $2, '2026-10-01', 'rentals', 'Nolo', $3, 1490),
       ($1, $2, '2026-10-02', 'materials', 'Viti', $3, 10),
       ($1, $2, '2026-10-03', 'materials', 'Cemento', $4, 1500),
       ($1, $2, '2026-10-04', 'subcontract', 'Impianti', $5, 125000),
       ($1, $2, '2026-10-05', 'other', 'Sabbia', null, 10),
       ($1, $2, '2026-10-06', 'materials', 'Ghiaia', null, 20),
       ($1, $6, '2026-10-07', 'materials', 'Altro cantiere', $4, 99999)`,
    [company.id, villetta, noli, calce, archived, box],
  )
  return {
    browser,
    company,
    villetta,
    box,
    noli,
    calce,
    archived,
    url: (site: string) => `/api/companies/${company.slug}/sites/${site}/cost-summary/suppliers`,
  }
}

describe('site costs per supplier', () => {
  it('groups the costs entered by hand by supplier, from the highest total', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.url(s.villetta))
    expect(res.statusCode).toBe(200)
    expect(res.json<SupplierCosts>()).toEqual({
      total: '1280.30',
      suppliers: [
        {
          supplier: { id: s.archived, name: 'Archiviato' },
          costs: 1,
          materials: '0.00',
          rentals: '0.00',
          subcontract: '1250.00',
          other: '0.00',
          total: '1250.00',
        },
        {
          supplier: { id: s.calce, name: 'Calcestruzzi' },
          costs: 1,
          materials: '15.00',
          rentals: '0.00',
          subcontract: '0.00',
          other: '0.00',
          total: '15.00',
        },
        {
          supplier: { id: s.noli, name: 'Noli Rossi' },
          costs: 2,
          materials: '0.10',
          rentals: '14.90',
          subcontract: '0.00',
          other: '0.00',
          total: '15.00',
        },
        {
          supplier: null,
          costs: 2,
          materials: '0.20',
          rentals: '0.00',
          subcontract: '0.00',
          other: '0.10',
          total: '0.30',
        },
      ],
    })
  })

  it('adds up to the costs entered by hand of the summary', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.url(s.villetta))
    const summary = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.villetta}/cost-summary`,
    )
    expect(summary.statusCode).toBe(200)
    const sum = summary.json<Record<string, string>>()
    const cents = (['materials', 'rentals', 'subcontract', 'other'] as const)
      .map((k) => BigInt((sum[k] ?? '').replace('.', '')))
      .reduce((a, b) => a + b, 0n)
    expect(cents).toBe(128030n)
    expect(res.json<SupplierCosts>().total).toBe('1280.30')
  })

  it('has no rows for a site without costs entered by hand', async () => {
    const s = await scene()
    await ctx.owner.query('delete from public.site_costs where site_id = $1', [s.box])
    const res = await s.browser.call('GET', s.url(s.box))
    expect(res.statusCode).toBe(200)
    expect(res.json<SupplierCosts>()).toEqual({ total: '0.00', suppliers: [] })
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
