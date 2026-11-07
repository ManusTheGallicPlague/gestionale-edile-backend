import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { parsePrice } from '../src/price-lists/import.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = [
  'price_lists.view',
  'price_lists.create',
  'price_lists.update',
  'price_lists.delete',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Prezzari', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}/price-lists`
  return { browser, company, base }
}

async function newList(browser: Browser, base: string) {
  const res = await browser.call('POST', base, {
    body: { name: 'Prezzario regionale', year: 2026, notes: null },
  })
  return `${base}/${res.json<{ id: string }>().id}`
}

const csv = (text: string, type = 'text/csv') => ({
  body: text,
  headers: { 'content-type': type },
})

interface Item {
  code: string
  description: string
  unit: string
  unit_price: string
}

async function items(browser: Browser, list: string) {
  const res = await browser.call('GET', `${list}/items?per_page=100`)
  return res.json<{ data: Item[] }>().data
}

describe('price list import', () => {
  it('reads Italian prices, any column order and quoted fields; updates by code', async () => {
    const s = await scene()
    const list = await newList(s.browser, s.base)
    await s.browser.call('POST', `${list}/items`, {
      body: { code: '01.A01', description: 'Vecchia', unit: 'm³', unit_price: '1' },
    })
    await s.browser.call('POST', `${list}/items`, {
      body: { code: '09.Z99', description: 'Non nel file', unit: 'h', unit_price: '30' },
    })
    const file =
      '﻿Prezzo;U.M.;Codice;Descrizione;Note\r\n' +
      '8,50;m³;01.a01;Scavo di sbancamento;x\r\n' +
      '"1.234,56";cad;02.B01;"Pilastro; in c.a.\r\nsu due righe";\r\n' +
      '\r\n' +
      '€ 12.5;m²;03.C01;"Intonaco ""civile""";\r\n'
    const res = await s.browser.call('POST', `${list}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 2, updated: 1, unchanged: 0 })
    const all = await items(s.browser, list)
    expect(all).toEqual([
      expect.objectContaining({
        code: '01.A01',
        description: 'Scavo di sbancamento',
        unit: 'm³',
        unit_price: '8.50',
      }),
      expect.objectContaining({
        code: '02.B01',
        description: 'Pilastro; in c.a.\r\nsu due righe',
        unit_price: '1234.56',
      }),
      expect.objectContaining({ code: '03.C01', description: 'Intonaco "civile"' }),
      expect.objectContaining({ code: '09.Z99', unit_price: '30.00' }),
    ])

    const again = await s.browser.call(
      'POST',
      `${list}/import`,
      csv(
        'codice,descrizione,unità,prezzo\n01.A01,Scavo di sbancamento,m³,9.00\n02.b01,Pilastro,cad,1234.56\n',
        'text/csv; charset=utf-8',
      ),
    )
    expect(again.json()).toEqual({ created: 0, updated: 2, unchanged: 0 })
    const tab = await s.browser.call(
      'POST',
      `${list}/import`,
      csv('code\tdescription\tunit\tunit_price\n01.A01\tScavo di sbancamento\tm³\t9\n'),
    )
    expect(tab.json()).toEqual({ created: 0, updated: 0, unchanged: 1 })
    expect((await s.browser.call('GET', list)).json()).toMatchObject({ item_count: 4 })
  })

  it('changes nothing when a row is wrong and says which rows', async () => {
    const s = await scene()
    const list = await newList(s.browser, s.base)
    const file =
      'codice;descrizione;unità;prezzo\n' +
      'A1;Buona;m;1,00\n' +
      ';Senza codice;m;1\n' +
      'A3;Negativa;m;-1\n' +
      'a1;Doppia;m;2\n' +
      `A5;${'x'.repeat(2001)};m;1\n`
    const res = await s.browser.call('POST', `${list}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(errors).sort()).toEqual(['row.3', 'row.4', 'row.5', 'row.6'])
    expect(errors['row.5']).toEqual(['Il codice è già alla riga 2.'])
    expect(await items(s.browser, list)).toEqual([])

    for (const [body, message] of [
      ['codice;descrizione;prezzo\nA;B;1\n', 'unità'],
      ['codice;descrizione;unità;prezzo\n', 'non ha voci'],
      ['   \n', 'vuoto'],
    ] as const) {
      const bad = await s.browser.call('POST', `${list}/import`, csv(body))
      expect(bad.statusCode).toBe(422)
      expect(bad.json<{ errors: { file: string[] } }>().errors.file[0]).toContain(message)
    }
    const latin1 = Buffer.from('codice;descrizione;unità;prezzo\nA;Più;m;1\n', 'latin1')
    const enc = await s.browser.call('POST', `${list}/import`, {
      body: latin1,
      headers: { 'content-type': 'text/csv' },
    })
    expect(enc.statusCode).toBe(422)
    expect(enc.json()).toMatchObject({ errors: { file: [expect.stringContaining('UTF-8')] } })
  })

  it('refuses other bodies, oversized files and missing permissions', async () => {
    const s = await scene()
    const list = await newList(s.browser, s.base)
    const json = await s.browser.call('POST', `${list}/import`, { body: { a: 1 } })
    expect(json.statusCode).toBe(415)
    const big = await s.browser.call(
      'POST',
      `${list}/import`,
      csv('codice;descrizione;unità;prezzo\n' + 'x'.repeat(5 * 1024 * 1024)),
    )
    expect(big.statusCode).toBe(413)
    const noCsrf = await s.browser.call('POST', `${list}/import`, {
      ...csv('codice;descrizione;unità;prezzo\nA;B;m;1\n'),
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)

    const viewer = await scene(['price_lists.view'])
    const own = await viewer.browser.call(
      'POST',
      `${viewer.base}/00000000-0000-4000-8000-000000000000/import`,
      csv('codice;descrizione;unità;prezzo\nA;B;m;1\n'),
    )
    expect(own.statusCode).toBe(403)

    // A user of another company does not see the list at all.
    const other = await scene()
    const foreign = await other.browser.call(
      'POST',
      `${other.base}/${list.split('/').pop() as string}/import`,
      csv('codice;descrizione;unità;prezzo\nA;B;m;1\n'),
    )
    expect(foreign.statusCode).toBe(404)
    expect(await items(s.browser, list)).toEqual([])
  })

  it('exports the items in a file that imports back unchanged', async () => {
    const s = await scene()
    const list = await newList(s.browser, s.base)
    await s.browser.call(
      'POST',
      `${list}/import`,
      csv(
        'codice;descrizione;unità;prezzo\n' +
          'B2;"Muratura; ""faccia vista""";m²;1.234,50\n' +
          'a1;=SOMMA(1);m;0,05\n',
      ),
    )
    const res = await s.browser.call('GET', `${list}/items/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="prezzario.csv"')
    expect(res.body).toBe(
      '\uFEFFCodice;Descrizione;Unità;Prezzo\r\n' +
        "a1;'=SOMMA(1);m;0,05\r\n" +
        'B2;"Muratura; ""faccia vista""";m²;1234,50\r\n',
    )
    const filtered = await s.browser.call('GET', `${list}/items/export?search=murat`)
    expect(filtered.body.split('\r\n')).toHaveLength(3)

    const again = await s.browser.call('POST', `${list}/import`, {
      body: res.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    // The apostrophe of the formula guard is dropped again on import.
    expect(again.json()).toEqual({ created: 0, updated: 0, unchanged: 2 })

    const other = await scene()
    const foreign = await other.browser.call(
      'GET',
      `${other.base}/${list.split('/').pop() as string}/items/export`,
    )
    expect(foreign.statusCode).toBe(404)
    const blind = await scene(['price_lists.update'])
    const hidden = await blind.browser.call(
      'GET',
      `${blind.base}/00000000-0000-4000-8000-000000000000/items/export`,
    )
    expect(hidden.statusCode).toBe(404)
  })

  it('parses prices without floating point', () => {
    expect(parsePrice('1.234,50')).toBe('123450')
    expect(parsePrice('1.234.567')).toBe('123456700')
    expect(parsePrice('0,1')).toBe('10')
    expect(parsePrice('12.345')).toBeNull()
    expect(parsePrice('1,234')).toBeNull()
    expect(parsePrice('-1')).toBeNull()
    expect(parsePrice('')).toBeNull()
  })
})
