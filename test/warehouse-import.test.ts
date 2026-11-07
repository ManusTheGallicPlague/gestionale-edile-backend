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
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Magazzino', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}/warehouse`
  return { browser, company, items: `${base}/items`, movements: `${base}/movements` }
}

const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

interface Item {
  code: string | null
  name: string
  unit: string
  stock: string
  notes: string | null
}

async function items(browser: Browser, base: string) {
  const res = await browser.call('GET', `${base}?per_page=100&sort=name`)
  return res.json<{ data: Item[] }>().data
}

describe('warehouse item import', () => {
  it('adds the items and loads their stock', async () => {
    const s = await scene()
    const file =
      'Codice;Articolo;Unità;Giacenza;Note\n' +
      'CEM-325;"Cemento 32,5 R";sacco;"40";\n' +
      'FER-08;Ferro tondino 8 mm;kg;"1.234,5";scaffale B\n' +
      ';Guanti;paio;0;\n' +
      ';Nastro;rotolo;;\n'
    const res = await s.browser.call('POST', `${s.items}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 4, stock_loaded: 2 })
    expect(await items(s.browser, s.items)).toEqual([
      expect.objectContaining({ code: 'CEM-325', name: 'Cemento 32,5 R', stock: '40.000' }),
      expect.objectContaining({ code: 'FER-08', stock: '1234.500', notes: 'scaffale B' }),
      expect.objectContaining({ code: null, name: 'Guanti', stock: '0.000' }),
      expect.objectContaining({ name: 'Nastro', unit: 'rotolo', stock: '0.000' }),
    ])
    const moves = await s.browser.call('GET', s.movements)
    const data = moves.json<{ data: { kind: string; quantity: string; notes: string }[] }>().data
    expect(data).toHaveLength(2)
    expect(
      data.every((m) => m.kind === 'in' && m.notes === 'Giacenza iniziale (importazione)'),
    ).toBe(true)

    // Its own export goes into another company with the same stock.
    const exported = await s.browser.call('GET', `${s.items}/export`)
    const other = await scene()
    const again = await other.browser.call('POST', `${other.items}/import`, {
      body: exported.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(again.json()).toEqual({ created: 4, stock_loaded: 2 })
    const strip = (list: Item[]) => list.map((x) => ({ ...x, id: 0, created_at: 0, updated_at: 0 }))
    expect(strip(await items(other.browser, other.items))).toEqual(
      strip(await items(s.browser, s.items)),
    )
  })

  it('changes nothing when a row is wrong, duplicates included', async () => {
    const s = await scene()
    const file =
      'codice;articolo;unità;giacenza\n' +
      'A1;Buono;pz;1\n' +
      'A2;Negativo;pz;-2,000\n' +
      'A3;Troppi decimali;pz;1,2345\n' +
      'A4;;;\n' +
      'a1;Doppio;pz;\n'
    const res = await s.browser.call('POST', `${s.items}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(errors).sort()).toEqual(['row.3', 'row.4', 'row.5'])
    expect(errors['row.3']).toEqual([
      'giacenza: una quantità non negativa, al massimo tre decimali (es. 12,500).',
    ])
    expect(errors['row.5']?.map((m) => m.split(':')[0])).toEqual(['articolo', 'unità'])

    const dup = 'codice;articolo;unità;giacenza\nX1;Uno;pz;5\nx1;Due;pz;3\n'
    const second = await s.browser.call('POST', `${s.items}/import`, csv(dup))
    expect(second.statusCode).toBe(422)
    expect(second.json<{ errors: unknown }>().errors).toEqual({
      'row.3': ['codice: Esiste già un articolo con questo codice.'],
    })
    expect(await items(s.browser, s.items)).toEqual([])
    const moves = await s.browser.call('GET', s.movements)
    expect(moves.json<{ data: unknown[] }>().data).toEqual([])
    const header = await s.browser.call('POST', `${s.items}/import`, csv('articolo\nA\n'))
    expect(header.json<{ errors: unknown }>().errors).toEqual({
      file: ['Nella prima riga manca la colonna unità.'],
    })
  })

  it('keeps each company to itself', async () => {
    const a = await scene()
    const b = await scene()
    const file = 'codice;articolo;unità\nC1;Cemento;sacco\n'
    expect((await a.browser.call('POST', `${a.items}/import`, csv(file))).statusCode).toBe(200)
    expect((await b.browser.call('POST', `${b.items}/import`, csv(file))).statusCode).toBe(200)
    const cross = await b.browser.call('POST', `${a.items}/import`, csv('articolo;unità\nX;pz\n'))
    expect(cross.statusCode).toBe(404)
    expect(await items(a.browser, a.items)).toHaveLength(1)
  })

  it('needs warehouse.create, the CSRF token and a CSV body', async () => {
    const viewer = await scene(['warehouse.view'])
    const file = 'articolo;unità\nA;pz\n'
    const denied = await viewer.browser.call('POST', `${viewer.items}/import`, csv(file))
    expect(denied.statusCode).toBe(403)
    const s = await scene()
    const noCsrf = await s.browser.call('POST', `${s.items}/import`, { ...csv(file), csrf: false })
    expect(noCsrf.statusCode).toBe(403)
    const json = await s.browser.call('POST', `${s.items}/import`, { body: { name: 'A' } })
    expect(json.statusCode).toBe(415)
  })
})
