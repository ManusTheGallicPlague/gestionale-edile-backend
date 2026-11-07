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

const ALL: Permission[] = ['warehouse.view', 'warehouse.create', 'warehouse.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Magazzino', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}`
  return { browser, company, items: `${base}/warehouse/items`, dashboard: `${base}/dashboard` }
}

type Scene = Awaited<ReturnType<typeof scene>>
type Item = { id: string; name: string; min_stock: string | null; below_min: boolean }

const item = (overrides: Record<string, unknown> = {}) => ({
  code: null,
  name: 'Cemento',
  unit: 'sacchi',
  notes: null,
  ...overrides,
})

/** An item with the given minimum and a stock of `stock`, through the API. */
async function stocked(s: Scene, name: string, minStock: string | null, stock: string | null) {
  const res = await s.browser.call('POST', s.items, {
    body: item({ name, min_stock: minStock }),
  })
  expect(res.statusCode).toBe(201)
  const created = res.json<Item>()
  if (stock !== null) {
    const moved = await s.browser.call(
      'POST',
      `/api/companies/${s.company.slug}/warehouse/movements`,
      {
        body: {
          item_id: created.id,
          date: '2026-11-04',
          kind: 'in',
          quantity: stock,
          site_id: null,
          notes: null,
        },
      },
    )
    expect(moved.statusCode).toBe(201)
  }
  return created
}

describe('minimum stock of the warehouse items', () => {
  it('flags the items below their minimum, in the list, the filter and the dashboard', async () => {
    const s = await scene()
    const other = await scene()
    await stocked(s, 'Sotto', '50', '10')
    await stocked(s, 'Uguale', '10.5', '10.5')
    await stocked(s, 'Sopra', '5', '6')
    await stocked(s, 'Vuoto', '0.001', null)
    await stocked(s, 'Senza minimo', null, null)
    await stocked(other, 'Sotto', '50', '10') // Another company must not count here.

    const list = await s.browser.call('GET', s.items)
    expect(list.statusCode).toBe(200)
    const byName = Object.fromEntries(
      list.json<{ data: Item[] }>().data.map((i) => [i.name, [i.min_stock, i.below_min]]),
    )
    expect(byName).toEqual({
      Sotto: ['50.000', true],
      Uguale: ['10.500', false],
      Sopra: ['5.000', false],
      Vuoto: ['0.001', true],
      'Senza minimo': [null, false],
    })
    const below = await s.browser.call('GET', `${s.items}?filter[below_min]=true`)
    expect(below.json<{ data: Item[] }>().data.map((i) => i.name)).toEqual(['Sotto', 'Vuoto'])
    const notBelow = await s.browser.call('GET', `${s.items}?filter[below_min]=false`)
    expect(notBelow.json<{ meta: { total: number } }>().meta.total).toBe(3)
    const csv = await s.browser.call('GET', `${s.items}/export?filter[below_min]=true`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\n')).toHaveLength(3)
    const wrong = await s.browser.call('GET', `${s.items}?filter[below_min]=si`)
    expect(wrong.statusCode).toBe(422)

    const dashboard = await s.browser.call('GET', s.dashboard)
    expect(dashboard.json<{ warehouse: unknown }>().warehouse).toEqual({ below_min: 2 })
  })

  it('keeps the minimum when an update does not send it, and checks it', async () => {
    const s = await scene()
    const created = await stocked(s, 'Sabbia', '12.250', null)
    const url = `${s.items}/${created.id}`
    const kept = await s.browser.call('PUT', url, {
      body: item({ name: 'Sabbia lavata' }),
      headers: { 'If-Match': '"1"' },
    })
    expect(kept.statusCode).toBe(200)
    expect(kept.json<Item>().min_stock).toBe('12.250')
    const cleared = await s.browser.call('PUT', url, {
      body: item({ name: 'Sabbia lavata', min_stock: null }),
      headers: { 'If-Match': '"2"' },
    })
    expect(cleared.json<Item>()).toMatchObject({ min_stock: null, below_min: false })
    for (const bad of ['-1', '1,5', '1.2345', 3]) {
      const res = await s.browser.call('POST', s.items, { body: item({ min_stock: bad }) })
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toHaveProperty('min_stock')
    }
    const plain = await s.browser.call('POST', s.items, { body: item({ name: 'Senza' }) })
    expect(plain.json<Item>().min_stock).toBeNull()
  })

  it('leaves the dashboard section null without warehouse.view', async () => {
    const s = await scene(['sites.view'])
    const res = await s.browser.call('GET', s.dashboard)
    expect(res.json<{ warehouse: unknown }>().warehouse).toBeNull()
  })
})
