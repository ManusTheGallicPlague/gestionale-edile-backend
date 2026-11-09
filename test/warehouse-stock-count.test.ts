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

async function newItem(s: Scene, name: string, code: string | null = null) {
  const res = await s.browser.call('POST', s.items, {
    body: { code, name, unit: 'sacchi', notes: null },
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

const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

describe('stock count from a CSV sheet', () => {
  it('reads the exported sheet with a Contata column', async () => {
    const s = await scene()
    const cement = await newItem(s, 'Cemento', 'CEM-01')
    const sand = await newItem(s, 'Sabbia')
    const gravel = await newItem(s, 'Ghiaia', 'GH')
    await move(s, cement.id, 'in', '40', '2026-12-01')
    await move(s, sand.id, 'in', '10', '2026-12-01')
    await move(s, gravel.id, 'in', '5', '2026-12-01')
    const sheet = await s.browser.call('GET', `${s.items}/export?as_of=2026-12-31&sort=name`)
    expect(sheet.statusCode).toBe(200)
    // The sheet as the warehouse fills it in: gravel is left blank, so it is not counted.
    const [header, ...rows] = sheet.body.trim().split('\r\n')
    const counts: Record<string, string> = { 'CEM-01': '38,5', '': '1.234,5' }
    const filled = [
      `${header};Contata`,
      ...rows.map((r) => `${r};${counts[r.split(';')[0] ?? ''] ?? ''}`),
    ].join('\r\n')
    const res = await s.browser.call(
      'POST',
      `${s.counts}/import?date=2026-12-31`,
      csv(filled.replace('CEM-01', 'cem-01')),
    )
    expect(res.statusCode).toBe(201)
    const data = res.json<{ data: CountLine[] }>().data
    expect(data.map((l) => [l.item_id, l.stock, l.counted, l.movement?.kind])).toEqual([
      [cement.id, '40.000', '38.500', 'out'],
      [sand.id, '10.000', '1234.500', 'in'],
    ])
    expect(data[0]?.movement).toMatchObject({
      date: '2026-12-31',
      quantity: '1.500',
      notes: 'Rettifica d’inventario (importazione)',
    })
    expect((await read(s, gravel.id)).stock).toBe('5.000')
    expect((await read(s, sand.id)).stock).toBe('1234.500')
  })

  it('changes nothing when a row is wrong and says which rows', async () => {
    const s = await scene()
    const cement = await newItem(s, 'Cemento', 'CEM-01')
    await newItem(s, 'Doppio', 'D1')
    await newItem(s, 'Doppio', 'D2')
    await move(s, cement.id, 'in', '40', '2026-12-01')
    const url = `${s.counts}/import?date=2026-12-31`
    const head = 'codice;articolo;contata'
    // Quantities and empty rows are checked first, then the items.
    const bad = await s.browser.call('POST', url, csv([head, 'CEM-01;;-1', ';;3'].join('\n')))
    expect(bad.statusCode).toBe(422)
    expect(bad.json<{ errors: Record<string, string[]> }>().errors).toEqual({
      'row.2': ['contata: una quantità non negativa, al massimo tre decimali (es. 12,500).'],
      'row.3': ['articolo: indica il codice o il nome.'],
    })
    const file = [head, 'CEM-01;;1', 'NOPE;;1', ';Doppio;1', ';Nessuno;1', ';Cemento;2'].join('\n')
    const res = await s.browser.call('POST', url, csv(file))
    expect(res.statusCode).toBe(422)
    expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
      'row.3': ['codice: nessun articolo con questo codice.'],
      'row.4': ['articolo: più articoli con questo nome, indica il codice.'],
      'row.5': ['articolo: nessun articolo con questo nome.'],
      'row.6': ['articolo: già contato alla riga 2.'],
    })
    expect((await read(s, cement.id)).stock).toBe('40.000')

    const errorsOf = async (path: string, body: string) => {
      const r = await s.browser.call('POST', path, csv(body))
      expect(r.statusCode).toBe(422)
      return Object.keys(r.json<{ errors: Record<string, string[]> }>().errors)
    }
    expect(await errorsOf(`${s.counts}/import`, 'codice;contata\nCEM-01;1\n')).toEqual(['date'])
    expect(await errorsOf(`${s.counts}/import?date=2026-02-30`, 'codice;contata\n')).toEqual([
      'date',
    ])
    expect(await errorsOf(url, 'codice;giacenza\nCEM-01;1\n')).toEqual(['file'])
    expect(await errorsOf(url, 'unità;contata\nsacchi;1\n')).toEqual(['file'])
    expect(await errorsOf(url, 'codice;contata\nCEM-01;\n')).toEqual(['file'])
    const wrongType = await s.browser.call('POST', url, { body: { lines: [] } })
    expect(wrongType.statusCode).toBe(415)
    expect((await read(s, cement.id)).stock).toBe('40.000')
  })

  it('finds only the items of its own company and needs warehouse.create', async () => {
    const s = await scene()
    const foreign = await scene()
    const theirs = await newItem(foreign, 'Cemento loro', 'CEM-01')
    await move(foreign, theirs.id, 'in', '10', '2026-01-01')
    const file = 'codice;articolo;contata\nCEM-01;;0\n;Cemento loro;0\n'
    const res = await s.browser.call('POST', `${s.counts}/import?date=2026-02-01`, csv(file))
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: Record<string, string[]> }>().errors)).toEqual([
      'row.2',
      'row.3',
    ])
    const across = await s.browser.call(
      'POST',
      `/api/companies/${foreign.company.slug}/warehouse/stock-counts/import?date=2026-02-01`,
      csv(file),
    )
    expect(across.statusCode).toBe(404)
    expect((await read(foreign, theirs.id)).stock).toBe('10.000')

    const viewer = await scene(['warehouse.view'])
    const url = `${viewer.counts}/import?date=2026-02-01`
    expect((await viewer.browser.call('POST', url, csv(file))).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('POST', url, csv(file))).statusCode).toBe(401)
  })
})
