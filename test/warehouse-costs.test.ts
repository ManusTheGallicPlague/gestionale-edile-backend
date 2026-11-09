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
  'warehouse.view',
  'warehouse.create',
  'warehouse.update',
  'warehouse.delete',
  'purchases.view',
  'purchases.create',
  'purchases.update',
]

async function scene() {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Magazzino', ALL))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}`
  return {
    browser,
    company,
    base,
    items: `${base}/warehouse/items`,
    movements: `${base}/warehouse/movements`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>
type Item = { id: string; stock: string; average_cost: string | null; stock_value: string | null }
type Movement = { id: string; unit_cost: string | null }

async function newItem(s: Scene, name = 'Cemento') {
  const res = await s.browser.call('POST', s.items, {
    body: { code: null, name, unit: 'sacchi', notes: null },
  })
  expect(res.statusCode).toBe(201)
  const created = res.json<Item>()
  expect(created).toMatchObject({ average_cost: null, stock_value: null })
  return created
}

function move(s: Scene, itemId: string, kind: 'in' | 'out', quantity: string, extra = {}) {
  return s.browser.call('POST', s.movements, {
    body: {
      item_id: itemId,
      date: '2026-11-05',
      kind,
      quantity,
      site_id: null,
      notes: null,
      ...extra,
    },
  })
}

async function read(s: Scene, id: string) {
  const res = await s.browser.call('GET', `${s.items}/${id}`)
  expect(res.statusCode).toBe(200)
  return res.json<Item>()
}

describe('unit costs and stock value of the warehouse', () => {
  it('averages the costs of the loads and values the stock', async () => {
    const s = await scene()
    const a = await newItem(s)

    // Loads without a cost (field omitted or null) give no average.
    expect((await move(s, a.id, 'in', '10')).json<Movement>().unit_cost).toBeNull()
    expect((await read(s, a.id)).stock_value).toBeNull()

    const first = await move(s, a.id, 'in', '0.1', { unit_cost: '0.1' })
    expect(first.statusCode).toBe(201)
    expect(first.json<Movement>().unit_cost).toBe('0.10')
    const second = await move(s, a.id, 'in', '0.2', { unit_cost: '0.20' })
    expect(second.statusCode).toBe(201)
    // (0.1 × 10 + 0.2 × 20) / 0.3 = 16.67 cents; the stock is 10.3, worth 10.3 × 16.666… cents.
    expect(await read(s, a.id)).toMatchObject({
      stock: '10.300',
      average_cost: '0.17',
      stock_value: '1.72',
    })

    const b = await newItem(s, 'Sabbia')
    await move(s, b.id, 'in', '10', { unit_cost: '6.50' })
    await move(s, b.id, 'in', '30', { unit_cost: '7' })
    await move(s, b.id, 'out', '15', { unit_cost: null })
    // (65 + 210) / 40 = 6.875 → 6.88; 25 × 6.875 = 171.875 → 171.88.
    expect(await read(s, b.id)).toMatchObject({
      stock: '25.000',
      average_cost: '6.88',
      stock_value: '171.88',
    })
    const list = await s.browser.call('GET', `${s.items}?sort=name`)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Item[] }>().data.map((i) => i.stock_value)).toEqual(['1.72', '171.88'])
    // The total is over every item that matches, not just the page; no cost counts as nothing.
    await newItem(s, 'Senza costo')
    const page = await s.browser.call('GET', `${s.items}?sort=-name&per_page=1`)
    expect(page.json<{ data: Item[]; stock_value: string }>()).toMatchObject({
      data: [{ stock_value: null }],
      stock_value: '173.60',
    })
    const dashboard = await s.browser.call('GET', `${s.base}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ warehouse: unknown }>().warehouse).toEqual({
      below_min: 0,
      stock_value: '173.60',
    })
    const found = await s.browser.call('GET', `${s.items}?search=sabb`)
    expect(found.json<{ stock_value: string }>().stock_value).toBe('171.88')

    // A stock below zero is worth nothing, not a negative amount.
    await move(s, b.id, 'out', '30')
    expect(await read(s, b.id)).toMatchObject({
      stock: '-5.000',
      average_cost: '6.88',
      stock_value: '0.00',
    })

    // A free load (cost zero) counts in the average.
    const c = await newItem(s, 'Tavole')
    await move(s, c.id, 'in', '1', { unit_cost: '0' })
    await move(s, c.id, 'in', '1', { unit_cost: '3' })
    expect(await read(s, c.id)).toMatchObject({ average_cost: '1.50', stock_value: '3.00' })
  })

  it('rejects a cost on an unload and costs that are not amounts, writing nothing', async () => {
    const s = await scene()
    const a = await newItem(s)
    for (const [kind, unitCost] of [
      ['out', '5'],
      ['in', 5],
      ['in', '-1'],
      ['in', '1,50'],
      ['in', '1.234'],
      ['in', 'abc'],
    ] as const) {
      const res = await move(s, a.id, kind, '1', { unit_cost: unitCost })
      expect(res.statusCode, `${kind} ${unitCost}`).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['unit_cost'])
    }
    const list = await s.browser.call('GET', `${s.movements}?filter[item]=${a.id}`)
    expect(list.json<{ data: unknown[] }>().data).toEqual([])
  })

  it('takes the unit costs of a load from a received order', async () => {
    const s = await scene()
    const a = await newItem(s)
    const b = await newItem(s, 'Sabbia')
    const supplier = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Edilizia Srl') returning id",
      [s.company.id],
    )
    const orders = `${s.base}/purchase-orders`
    const order = await s.browser.call('POST', orders, {
      body: {
        supplier_id: supplier.rows[0]?.id,
        site_id: null,
        date: '2026-11-02',
        delivery_date: null,
        notes: null,
        lines: [{ description: 'Cemento', unit: 'sacchi', quantity: '50', unit_price: '6' }],
      },
    })
    const orderId = order.json<{ id: string }>().id
    for (const [status, version] of [
      ['sent', 1],
      ['received', 2],
    ] as const) {
      await s.browser.call('POST', `${orders}/${orderId}/status`, {
        body: { status },
        headers: { 'If-Match': `"${version}"` },
      })
    }
    const loads = `${orders}/${orderId}/warehouse-loads`
    const bad = await s.browser.call('POST', loads, {
      body: {
        date: '2026-11-06',
        lines: [
          { item_id: a.id, quantity: '50', unit_cost: '6.001' },
          { item_id: b.id, quantity: '1', unit_cost: 6 },
        ],
      },
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'lines.0.unit_cost',
      'lines.1.unit_cost',
    ])
    const res = await s.browser.call('POST', loads, {
      body: {
        date: '2026-11-06',
        lines: [
          { item_id: a.id, quantity: '50', unit_cost: '6' },
          { item_id: b.id, quantity: '2', unit_cost: null },
          { item_id: b.id, quantity: '3' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: Movement[] }>().data.map((m) => m.unit_cost)).toEqual([
      '6.00',
      null,
      null,
    ])
    expect(await read(s, a.id)).toMatchObject({ average_cost: '6.00', stock_value: '300.00' })
    expect(await read(s, b.id)).toMatchObject({ average_cost: null, stock_value: null })
  })

  it('puts the costs in the CSV files, and the items file still imports', async () => {
    const s = await scene()
    const a = await newItem(s)
    await move(s, a.id, 'in', '10', { unit_cost: '6.5' })
    await move(s, a.id, 'out', '4')
    await newItem(s, 'Sabbia')
    const items = await s.browser.call('GET', `${s.items}/export?sort=name`)
    expect(items.statusCode).toBe(200)
    const lines = items.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toEqual([
      'Codice;Articolo;Unità;Giacenza;Note;Costo medio;Valore',
      ';Cemento;sacchi;6,000;;6,50;39,00',
      ';Sabbia;sacchi;0,000;;;',
    ])
    const moves = await s.browser.call('GET', `${s.movements}/export`)
    expect(moves.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Data;Tipo;Codice;Articolo;Unità;Quantità;Cantiere;Ordine;Note;Costo unitario;Valore',
      // The unload on the same day as the load is worth the average of that day.
      '05/11/2026;Scarico;;Cemento;sacchi;4,000;;;;;26,00',
      '05/11/2026;Carico;;Cemento;sacchi;10,000;;;;6,50;65,00',
    ])

    // The file goes back in another company as it is: the extra columns are ignored.
    const other = await scene()
    const imported = await other.browser.call('POST', `${other.items}/import`, {
      body: items.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(imported.statusCode).toBe(200)
    expect(imported.json()).toEqual({ created: 2, stock_loaded: 1 })
    const list = await other.browser.call('GET', `${other.items}?sort=name`)
    expect(list.json<{ data: Item[] }>().data.map((i) => [i.stock, i.stock_value])).toEqual([
      ['6.000', null],
      ['0.000', null],
    ])
  })

  it('gives the stock and its value at the end of a day (as_of)', async () => {
    const s = await scene()
    const a = await newItem(s)
    await s.browser.call('PUT', `${s.items}/${a.id}`, {
      body: { code: null, name: 'Cemento', unit: 'sacchi', notes: null, min_stock: '15' },
      headers: { 'If-Match': '"1"' },
    })
    const at = (date: string, kind: 'in' | 'out', quantity: string, extra = {}) =>
      move(s, a.id, kind, quantity, { date, ...extra })
    await at('2026-12-10', 'in', '20', { unit_cost: '5' })
    await at('2026-12-31', 'out', '4')
    await at('2027-01-02', 'in', '20', { unit_cost: '7' })
    await at('2027-01-03', 'out', '30')

    const yearEnd = await s.browser.call('GET', `${s.items}?as_of=2026-12-31`)
    expect(yearEnd.statusCode).toBe(200)
    expect(yearEnd.json<{ data: Item[]; stock_value: string }>()).toMatchObject({
      data: [{ stock: '16.000', average_cost: '5.00', stock_value: '80.00', below_min: false }],
      stock_value: '80.00',
    })
    const before = await s.browser.call('GET', `${s.items}?as_of=2026-12-09`)
    expect(before.json<{ data: Item[] }>().data[0]).toMatchObject({
      stock: '0.000',
      average_cost: null,
      stock_value: null,
      below_min: true,
    })
    // Today: every movement, the second load in the average.
    expect((await s.browser.call('GET', s.items)).json<{ data: Item[] }>().data[0]).toMatchObject({
      stock: '6.000',
      average_cost: '6.00',
      stock_value: '36.00',
      below_min: true,
    })
    // The filter on the minimum stock looks at the same day.
    const low = (asOf: string) =>
      s.browser.call('GET', `${s.items}?as_of=${asOf}&filter[below_min]=true`)
    expect((await low('2026-12-31')).json<{ data: Item[] }>().data).toEqual([])
    expect((await low('2027-01-03')).json<{ data: Item[] }>().data).toHaveLength(1)

    const csv = await s.browser.call('GET', `${s.items}/export?as_of=2026-12-31`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="magazzino-al-2026-12-31.csv"',
    )
    expect(csv.body).toContain(';Cemento;sacchi;16,000;;5,00;80,00')

    for (const url of [`${s.items}?as_of=31/12/2026`, `${s.items}/export?as_of=2026-02-30`]) {
      const bad = await s.browser.call('GET', url)
      expect(bad.statusCode, url).toBe(422)
      expect(Object.keys(bad.json<{ errors: object }>().errors)).toEqual(['as_of'])
    }
  })

  it('counts only the loads still there, and of this company', async () => {
    const s = await scene()
    const a = await newItem(s)
    await move(s, a.id, 'in', '1', { unit_cost: '10' })
    const dear = (await move(s, a.id, 'in', '1', { unit_cost: '30' })).json<Movement>()
    expect((await read(s, a.id)).average_cost).toBe('20.00')
    const removed = await s.browser.call('DELETE', `${s.movements}/${dear.id}`)
    expect(removed.statusCode).toBe(204)
    expect(await read(s, a.id)).toMatchObject({ average_cost: '10.00', stock_value: '10.00' })

    // A load of another company on this item is refused by the database (RLS and keys).
    const other = await scene()
    const cross = await move(other, a.id, 'in', '100', { unit_cost: '1000' })
    expect(cross.statusCode).toBe(422)
    expect(await read(s, a.id)).toMatchObject({ average_cost: '10.00', stock_value: '10.00' })
    // And the other company cannot read the item, its cost or its value.
    const peek = await other.browser.call('GET', `${other.items}/${a.id}`)
    expect(peek.statusCode).toBe(404)
    // Nor does this company's value add to the other's total.
    const total = await other.browser.call('GET', other.items)
    expect(total.json<{ stock_value: string }>().stock_value).toBe('0.00')
  })
})
