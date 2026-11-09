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

const ALL: Permission[] = ['warehouse.view', 'warehouse.create', 'warehouse.delete']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Magazzino', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}`
  return {
    browser,
    company,
    items: `${base}/warehouse/items`,
    movements: `${base}/warehouse/movements`,
    counts: `${base}/warehouse/stock-counts`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>
type Item = { id: string; stock: string; average_cost: string | null; stock_value: string | null }
type Movement = {
  id: string
  item: { id: string }
  date: string
  kind: 'in' | 'out'
  quantity: string
  site_id: string | null
  notes: string | null
  unit_cost: string | null
  value: string | null
}
type CountLine = { item_id: string; stock: string; counted: string; movement: Movement | null }

async function newItem(s: Scene, name: string) {
  const res = await s.browser.call('POST', s.items, {
    body: { code: null, name, unit: 'sacchi', notes: null },
  })
  expect(res.statusCode).toBe(201)
  return res.json<Item>()
}

async function move(
  s: Scene,
  itemId: string,
  kind: 'in' | 'out',
  quantity: string,
  date: string,
  unit_cost: string | null = null,
) {
  const res = await s.browser.call('POST', s.movements, {
    body: { item_id: itemId, date, kind, quantity, site_id: null, notes: null, unit_cost },
  })
  expect(res.statusCode).toBe(201)
}

async function read(s: Scene, id: string) {
  return (await s.browser.call('GET', `${s.items}/${id}`)).json<Item>()
}

describe('stock count of the warehouse', () => {
  it('records the difference from the stock at the date of the count', async () => {
    const s = await scene()
    const cement = await newItem(s, 'Cemento')
    const sand = await newItem(s, 'Sabbia')
    const bricks = await newItem(s, 'Mattoni')
    const empty = await newItem(s, 'Mai movimentato')
    await move(s, cement.id, 'in', '10.2', '2026-12-01', '5.00')
    await move(s, cement.id, 'in', '0.1', '2026-12-31', '7.00')
    // After the count: it stays and keeps counting.
    await move(s, cement.id, 'out', '3', '2027-01-02')
    await move(s, sand.id, 'in', '20', '2026-12-10')
    await move(s, sand.id, 'out', '5', '2026-12-31')
    await move(s, bricks.id, 'in', '100', '2026-11-01')

    const res = await s.browser.call('POST', s.counts, {
      body: {
        date: '2026-12-31',
        lines: [
          { item_id: cement.id, quantity: '10.000' },
          { item_id: sand.id, quantity: '18.5' },
          { item_id: bricks.id, quantity: '100' },
          { item_id: empty.id, quantity: '0' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const data = res.json<{ data: CountLine[] }>().data
    expect(data.map((l) => [l.item_id, l.stock, l.counted])).toEqual([
      [cement.id, '10.300', '10.000'],
      [sand.id, '15.000', '18.500'],
      [bricks.id, '100.000', '100.000'],
      [empty.id, '0.000', '0.000'],
    ])
    expect(data[0]?.movement).toMatchObject({
      item: { id: cement.id },
      date: '2026-12-31',
      kind: 'out',
      quantity: '0.300',
      site_id: null,
      notes: 'Rettifica d’inventario',
      unit_cost: null,
    })
    expect(data[1]?.movement).toMatchObject({ kind: 'in', quantity: '3.500', unit_cost: null })
    expect(data[2]?.movement).toBeNull()
    expect(data[3]?.movement).toBeNull()

    // 10 counted − 3 unloaded later; the average cost does not change with a count.
    const after = await read(s, cement.id)
    expect(after.stock).toBe('7.000')
    // (10.2 × 5 + 0.1 × 7) / 10.3 = 5.019… → 5.02, as before the count.
    expect(after.average_cost).toBe('5.02')
    expect((await read(s, sand.id)).stock).toBe('18.500')
    const atDate = await s.browser.call('GET', `${s.items}?as_of=2026-12-31&sort=name`)
    expect(atDate.json<{ data: Item[] }>().data.map((i) => i.stock)).toEqual([
      '10.000',
      '0.000',
      '100.000',
      '18.500',
    ])

    // Counting again the same day finds the stock already corrected.
    const again = await s.browser.call('POST', s.counts, {
      body: {
        date: '2026-12-31',
        notes: 'Seconda conta',
        lines: [{ item_id: sand.id, quantity: '18' }],
      },
    })
    expect(again.statusCode).toBe(201)
    expect(again.json<{ data: CountLine[] }>().data[0]).toMatchObject({
      stock: '18.500',
      counted: '18.000',
      movement: { kind: 'out', quantity: '0.500', notes: 'Seconda conta' },
    })
  })

  it('corrects a negative stock and counts the same day movements', async () => {
    const s = await scene()
    const item = await newItem(s, 'Ghiaia')
    await move(s, item.id, 'out', '4', '2026-06-30')
    const res = await s.browser.call('POST', s.counts, {
      body: { date: '2026-06-30', notes: null, lines: [{ item_id: item.id, quantity: '1' }] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: CountLine[] }>().data[0]).toMatchObject({
      stock: '-4.000',
      movement: { kind: 'in', quantity: '5.000', notes: 'Rettifica d’inventario' },
    })
    expect((await read(s, item.id)).stock).toBe('1.000')
  })

  it('rejects invalid counts without writing anything', async () => {
    const s = await scene()
    const item = await newItem(s, 'Cemento')
    const other = await newItem(s, 'Sabbia')
    await move(s, item.id, 'in', '10', '2026-01-01')
    const fail = async (body: unknown, fields: string[]) => {
      const res = await s.browser.call('POST', s.counts, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: Record<string, string[]> }>().errors).sort()).toEqual(
        fields.sort(),
      )
    }
    await fail({ date: '2026-13-01', lines: [] }, ['date', 'lines'])
    await fail({ lines: [{ item_id: item.id, quantity: '1' }] }, ['date'])
    await fail(
      {
        date: '2026-02-01',
        lines: [
          { item_id: other.id, quantity: '2' },
          { item_id: item.id, quantity: '-1' },
          { item_id: item.id.toUpperCase(), quantity: '1' },
          { item_id: 'nope', quantity: '1,5' },
          { item_id: other.id, quantity: 3 },
        ],
      },
      [
        'lines.1.quantity',
        'lines.2.item_id',
        'lines.3.item_id',
        'lines.3.quantity',
        'lines.4.item_id',
        'lines.4.quantity',
      ],
    )
    await fail(
      {
        date: '2026-02-01',
        lines: Array.from({ length: 201 }, () => ({ item_id: item.id, quantity: '1' })),
      },
      ['lines'],
    )
    // An unknown item fails the whole count: the known one is not corrected either.
    await fail(
      {
        date: '2026-02-01',
        lines: [
          { item_id: item.id, quantity: '1' },
          { item_id: '00000000-0000-4000-8000-000000000000', quantity: '1' },
        ],
      },
      ['lines.1.item_id'],
    )
    // A difference that does not fit in a movement.
    await move(s, other.id, 'out', '99999999999', '2026-01-01')
    await fail({ date: '2026-02-01', lines: [{ item_id: other.id, quantity: '99999999999' }] }, [
      'lines.0.quantity',
    ])
    const list = await s.browser.call('GET', s.movements)
    expect(list.json<{ data: Movement[] }>().data).toHaveLength(2)
    expect((await read(s, item.id)).stock).toBe('10.000')
  })

  it('does not touch the items of another company', async () => {
    const s = await scene()
    const foreign = await scene()
    const theirs = await newItem(foreign, 'Cemento loro')
    await move(foreign, theirs.id, 'in', '10', '2026-01-01')
    const res = await s.browser.call('POST', s.counts, {
      body: { date: '2026-02-01', lines: [{ item_id: theirs.id, quantity: '0' }] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { 'lines.0.item_id': ['Articolo non trovato.'] } })
    expect((await read(foreign, theirs.id)).stock).toBe('10.000')
    // Nor through the other company's path.
    const across = await s.browser.call(
      'POST',
      `/api/companies/${foreign.company.slug}/warehouse/stock-counts`,
      { body: { date: '2026-02-01', lines: [{ item_id: theirs.id, quantity: '0' }] } },
    )
    expect(across.statusCode).toBe(404)
    expect((await read(foreign, theirs.id)).stock).toBe('10.000')
  })

  it('needs warehouse.create and a session', async () => {
    const owner = await scene()
    const item = await newItem(owner, 'Cemento')
    const body = { date: '2026-02-01', lines: [{ item_id: item.id, quantity: '1' }] }
    const reader = await fx.user()
    await fx.member(
      reader.id,
      owner.company.id,
      await fx.role(owner.company.id, 'Lettura', ['warehouse.view']),
    )
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.email)
    expect((await browser.call('POST', owner.counts, { body })).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('POST', owner.counts, { body })).statusCode).toBe(401)
    expect((await read(owner, item.id)).stock).toBe('0.000')
  })
})
