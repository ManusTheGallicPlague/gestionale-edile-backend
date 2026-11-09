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

async function vehicleOf(companyId: string, name: string, plate: string | null = null) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, plate)
     values ($1, $2, 'machine', $3) returning id`,
    [companyId, name, plate],
  )
  return rows[0]?.id ?? ''
}

async function maintenance(
  companyId: string,
  vehicleId: string,
  performedOn: string,
  cents: number | null,
  supplierId: string | null = null,
) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind,
       description, supplier_id, amount_cents)
     values ($1, $2, $3, 'repair', 'Lavoro', $4, $5) returning id`,
    [companyId, vehicleId, performedOn, supplierId, cents],
  )
  return rows[0]?.id ?? ''
}

async function scene(permissions: Permission[] = ['vehicles.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, url: `/api/companies/${company.slug}/vehicle-maintenances` }
}

type Row = { id: string; vehicle: { id: string; name: string; plate: string | null } }
type List = { data: Row[]; meta: { total: number }; total_amount: string }

describe('maintenance of all the vehicles', () => {
  it('lists every vehicle newest first, a page at a time, with the total of the filter', async () => {
    const { browser, company, url } = await scene()
    const truck = await vehicleOf(company.id, 'Camion', 'AB123CD')
    const digger = await vehicleOf(company.id, 'Escavatore')
    const { rows } = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Officina') returning id",
      [company.id],
    )
    const old = await maintenance(company.id, truck, '2026-09-01', 10)
    const a = await maintenance(company.id, digger, '2026-10-15', 20, rows[0]?.id ?? null)
    const b = await maintenance(company.id, truck, '2026-10-15', null)
    const latest = await maintenance(company.id, digger, '2026-11-02', 123456)

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    const list = res.json<List>()
    // Same day: in order of vehicle name, as in the CSV.
    expect(list.data.map((r) => r.id)).toEqual([latest, b, a, old])
    expect(list.meta).toEqual({ total: 4, page: 1, per_page: 25 })
    expect(list.total_amount).toBe('1234.86')
    expect(list.data[1]).toMatchObject({
      vehicle: { id: truck, name: 'Camion', plate: 'AB123CD' },
      amount: null,
    })
    expect(list.data[2]).toMatchObject({ supplier: { name: 'Officina' } })

    // The total counts every row of the filter, not only the page.
    const page = await browser.call('GET', `${url}?page=2&per_page=1`)
    expect(page.json<List>()).toMatchObject({
      meta: { total: 4, page: 2, per_page: 1 },
      total_amount: '1234.86',
    })
    expect(page.json<List>().data.map((r) => r.id)).toEqual([b])

    const filtered = await browser.call(
      'GET',
      `${url}?filter[from]=2026-10-15&filter[to]=2026-10-15&filter[vehicle]=${digger}`,
    )
    expect(filtered.json<List>().data.map((r) => r.id)).toEqual([a])
    expect(filtered.json<List>().total_amount).toBe('0.20')

    const unknown = await browser.call(
      'GET',
      `${url}?filter[vehicle]=00000000-0000-4000-8000-000000000000`,
    )
    expect(unknown.json()).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25 },
      total_amount: '0.00',
    })
  })

  it('rejects wrong filters and pages', async () => {
    const { browser, url } = await scene()
    for (const query of [
      'filter[from]=2026-13-01',
      'filter[from]=2026-11-02&filter[to]=2026-11-01',
      'filter[vehicle]=nope',
      'page=0',
      'per_page=101',
    ]) {
      expect((await browser.call('GET', `${url}?${query}`)).statusCode).toBe(422)
    }
  })

  it('needs vehicles.view and shows only the company’s maintenance', async () => {
    const none = await scene(['sites.view'])
    expect((await none.browser.call('GET', none.url)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', none.url)).statusCode).toBe(401)

    const mine = await scene()
    const theirs = await scene()
    const their = await vehicleOf(theirs.company.id, 'Loro')
    await maintenance(theirs.company.id, their, '2026-10-01', 999)
    const res = await mine.browser.call('GET', mine.url)
    expect(res.json()).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25 },
      total_amount: '0.00',
    })
    const filtered = await mine.browser.call('GET', `${mine.url}?filter[vehicle]=${their}`)
    expect(filtered.json<List>().data).toEqual([])
    expect(filtered.body).not.toContain('Loro')
    const other = `/api/companies/${theirs.company.slug}/vehicle-maintenances`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
  })
})
