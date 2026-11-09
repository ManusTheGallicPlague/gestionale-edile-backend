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
  'sites.delete',
  'purchases.view',
  'purchases.create',
  'purchases.update',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Magazzino', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1') returning id",
    [company.id],
  )
  const base = `/api/companies/${company.slug}/warehouse`
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    items: `${base}/items`,
    moves: `${base}/movements`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>
type Item = { id: string; code: string | null; name: string; stock: string }

const item = (overrides: Record<string, unknown> = {}) => ({
  code: 'CEM-325',
  name: 'Cemento 32.5 in sacchi',
  unit: 'sacchi',
  notes: null,
  ...overrides,
})

const move = (s: Scene, itemId: string, overrides: Record<string, unknown> = {}) => ({
  item_id: itemId,
  date: '2026-11-04',
  kind: 'in',
  quantity: '100',
  site_id: null,
  notes: null,
  ...overrides,
})

describe('warehouse', () => {
  it('exports the items with their stock as CSV, with the same search', async () => {
    const s = await scene()
    const cement = (await s.browser.call('POST', s.items, { body: item() })).json<Item>()
    await s.browser.call('POST', s.items, {
      body: item({ code: null, name: 'Sabbia lavata', unit: 'm³', notes: 'cava nord' }),
    })
    await s.browser.call('POST', s.moves, { body: move(s, cement.id, { quantity: '12.5' }) })
    const url = `${s.items}/export`
    const res = await s.browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="magazzino.csv"')
    expect(res.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Codice;Articolo;Unità;Giacenza;Note;Costo medio;Valore',
      'CEM-325;Cemento 32.5 in sacchi;sacchi;12,500;;;',
      ';Sabbia lavata;m³;0,000;cava nord;;',
    ])
    const found = await s.browser.call('GET', `${url}?search=sabb`)
    expect(found.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?sort=prezzo`)).statusCode).toBe(422)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.items}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('exports the movements as CSV, with the same filters and order as the list', async () => {
    const s = await scene()
    const cement = (await s.browser.call('POST', s.items, { body: item() })).json<Item>()
    const sand = (
      await s.browser.call('POST', s.items, {
        body: item({ code: null, name: 'Sabbia lavata', unit: 'm³' }),
      })
    ).json<Item>()
    const post = async (body: Record<string, unknown>) =>
      expect((await s.browser.call('POST', s.moves, { body })).statusCode).toBe(201)
    await post(move(s, cement.id, { date: '2026-11-02', quantity: '100' }))
    await post(move(s, sand.id, { date: '2026-11-03', quantity: '10.25' }))
    await post(
      move(s, cement.id, {
        date: '2026-11-05',
        kind: 'out',
        quantity: '12.5',
        site_id: s.site,
        notes: 'getto; platea',
      }),
    )
    await post(move(s, sand.id, { date: '2026-11-06', kind: 'out', quantity: '2' }))
    // Another company's movements never end up in the file.
    const theirs = await scene()
    const their = (await theirs.browser.call('POST', theirs.items, { body: item() })).json<Item>()
    await theirs.browser.call('POST', theirs.moves, { body: move(theirs, their.id) })

    const url = `${s.moves}/export`
    const res = await s.browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="movimenti-magazzino.csv"',
    )
    expect(res.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Data;Tipo;Codice;Articolo;Unità;Quantità;Cantiere;Ordine;Note;Costo unitario;Valore',
      '06/11/2026;Scarico;;Sabbia lavata;m³;2,000;;;;;',
      '05/11/2026;Scarico;CEM-325;Cemento 32.5 in sacchi;sacchi;12,500;C-1 Villetta;;"getto; platea";;',
      '03/11/2026;Carico;;Sabbia lavata;m³;10,250;;;;;',
      '02/11/2026;Carico;CEM-325;Cemento 32.5 in sacchi;sacchi;100,000;;;;;',
    ])

    // What went to a site: the same filters as the list.
    const toSite = await s.browser.call(
      'GET',
      `${url}?filter[site]=${s.site}&filter[kind]=out&filter[from]=2026-11-01`,
    )
    expect(toSite.body.trim().split('\r\n')).toHaveLength(2)
    expect(toSite.body).toContain('12,500')
    const sandOnly = await s.browser.call(
      'GET',
      `${url}?filter[item]=${sand.id}&filter[to]=2026-11-05`,
    )
    expect(sandOnly.body.trim().split('\r\n')).toHaveLength(2)
    expect(sandOnly.body).toContain('10,250')
    expect((await s.browser.call('GET', `${url}?filter[kind]=reso`)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${url}?filter[from]=05/11/2026`)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${url}?filter[site]=x`)).statusCode).toBe(422)

    const theirFile = await theirs.browser.call('GET', `${theirs.moves}/export`)
    expect(theirFile.body.trim().split('\r\n')).toHaveLength(2)
    expect((await theirs.browser.call('GET', url)).statusCode).toBe(404)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.moves}/export`)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })

  it('searches the notes, the code and the name of the item, also in the CSV', async () => {
    const s = await scene()
    const cement = (await s.browser.call('POST', s.items, { body: item() })).json<Item>()
    const sand = (
      await s.browser.call('POST', s.items, {
        body: item({ code: null, name: 'Sabbia lavata', unit: 'm³' }),
      })
    ).json<Item>()
    const post = async (body: Record<string, unknown>) => {
      const res = await s.browser.call('POST', s.moves, { body })
      expect(res.statusCode).toBe(201)
      return res.json<{ id: string }>().id
    }
    const bill = await post(move(s, sand.id, { date: '2026-11-02', notes: 'DDT 451 della cava' }))
    const cementIn = await post(move(s, cement.id, { date: '2026-11-03' }))
    const percent = await post(move(s, sand.id, { date: '2026-11-04', notes: 'calo 5%' }))
    const plain = await post(move(s, sand.id, { date: '2026-11-05' }))
    // Another company with the same item and notes never shows up.
    const theirs = await scene()
    const their = (await theirs.browser.call('POST', theirs.items, { body: item() })).json<Item>()
    await theirs.browser.call('POST', theirs.moves, {
      body: move(theirs, their.id, { notes: 'DDT 451 della cava' }),
    })

    type Moves = { data: { id: string }[]; meta: { total: number } }
    const ids = async (query: string) => {
      const res = await s.browser.call('GET', `${s.moves}?filter[q]=${encodeURIComponent(query)}`)
      expect(res.statusCode).toBe(200)
      return res.json<Moves>().data.map((m) => m.id)
    }
    expect(await ids(' ddt 451 ')).toEqual([bill])
    expect(await ids('cem-325')).toEqual([cementIn])
    expect(await ids('SABBIA')).toEqual([plain, percent, bill])
    // % is text, not a wildcard.
    expect(await ids('%')).toEqual([percent])
    expect(await ids('   ')).toEqual([plain, percent, cementIn, bill])

    const csv = await s.browser.call('GET', `${s.moves}/export?filter[q]=cava`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\r\n')).toHaveLength(2)
    expect(csv.body).toContain('DDT 451')

    for (const query of [`filter[q]=${'x'.repeat(101)}`, 'filter[q]=a&filter[q]=b']) {
      expect((await s.browser.call('GET', `${s.moves}?${query}`)).statusCode).toBe(422)
      expect((await s.browser.call('GET', `${s.moves}/export?${query}`)).statusCode).toBe(422)
    }
  })

  it('creates, reads, updates and deletes an item with If-Match', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.items, { body: item() })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const it1 = created.json<Item>()
    expect(it1).toMatchObject({ code: 'CEM-325', unit: 'sacchi', stock: '0.000' })
    const url = `${s.items}/${it1.id}`
    expect((await s.browser.call('GET', url)).json()).toEqual(it1)
    const dup = await s.browser.call('POST', s.items, { body: item({ code: 'cem-325' }) })
    expect(dup.statusCode).toBe(422)
    expect(Object.keys(dup.json<{ errors: object }>().errors)).toEqual(['code'])
    const bad = await s.browser.call('POST', s.items, { body: { code: 1, name: ' ' } })
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'code',
      'name',
      'notes',
      'unit',
    ])
    expect((await s.browser.call('PUT', url, { body: item() })).statusCode).toBe(428)
    const updated = await s.browser.call('PUT', url, {
      body: item({ code: null, name: 'Cemento' }),
      headers: { 'If-Match': '"1"' },
    })
    expect(updated.json()).toMatchObject({ code: null, name: 'Cemento' })
    expect(
      (await s.browser.call('PUT', url, { body: item(), headers: { 'If-Match': '"1"' } }))
        .statusCode,
    ).toBe(412)
    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('loads and unloads, computes the stock and filters the movements', async () => {
    const s = await scene()
    const a = (await s.browser.call('POST', s.items, { body: item() })).json<Item>()
    const b = (
      await s.browser.call('POST', s.items, {
        body: item({ code: 'SAB', name: 'Sabbia', unit: 'm³' }),
      })
    ).json<Item>()
    const created = await s.browser.call('POST', s.moves, { body: move(s, a.id) })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      kind: 'in',
      quantity: '100.000',
      item: { id: a.id, code: 'CEM-325', unit: 'sacchi' },
      site: null,
    })
    const out = await s.browser.call('POST', s.moves, {
      body: move(s, a.id, { kind: 'out', quantity: '30.5', site_id: s.site, date: '2026-11-05' }),
    })
    expect(out.json()).toMatchObject({ site: { id: s.site, name: 'Villetta' } })
    await s.browser.call('POST', s.moves, { body: move(s, b.id, { kind: 'out', quantity: '2' }) })
    expect((await s.browser.call('GET', `${s.items}/${a.id}`)).json()).toMatchObject({
      stock: '69.500',
    })
    type List = { data: Item[]; meta: { total: number } }
    const list = (await s.browser.call('GET', `${s.items}?sort=-stock`)).json<List>()
    expect(list.data.map((i) => i.stock)).toEqual(['69.500', '-2.000'])
    const found = (await s.browser.call('GET', `${s.items}?search=sabb`)).json<List>()
    expect(found.data.map((i) => i.name)).toEqual(['Sabbia'])
    type Moves = { data: { quantity: string; date: string }[]; meta: { total: number } }
    const all = (await s.browser.call('GET', s.moves)).json<Moves>()
    expect(all.meta.total).toBe(3)
    expect(all.data[0]?.date).toBe('2026-11-05')
    const toSite = await s.browser.call(
      'GET',
      `${s.moves}?filter[site]=${s.site}&filter[kind]=out&filter[item]=${a.id}&filter[from]=2026-11-05&filter[to]=2026-11-05`,
    )
    expect(toSite.json<Moves>().data.map((m) => m.quantity)).toEqual(['30.500'])
    expect((await s.browser.call('GET', `${s.moves}?filter[kind]=x`)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${s.items}?sort=x`)).statusCode).toBe(422)

    const invalid = await s.browser.call('POST', s.moves, {
      body: move(s, a.id, { kind: 'su', quantity: '0', date: 'ieri', site_id: 'x' }),
    })
    expect(Object.keys(invalid.json<{ errors: object }>().errors).sort()).toEqual([
      'date',
      'kind',
      'quantity',
      'site_id',
    ])
    const foreign = await scene()
    const other = (await foreign.browser.call('POST', foreign.items, { body: item() })).json<Item>()
    const cross = await s.browser.call('POST', s.moves, {
      body: move(s, other.id, { site_id: foreign.site }),
    })
    expect(Object.keys(cross.json<{ errors: object }>().errors).sort()).toEqual([
      'item_id',
      'site_id',
    ])

    // Items and sites with movements stay; a movement goes and the stock follows.
    const keep = await s.browser.call('DELETE', `${s.items}/${a.id}`, {
      headers: { 'If-Match': '"1"' },
    })
    expect(keep.statusCode).toBe(409)
    expect(keep.json()).toMatchObject({ code: 'has_documents' })
    const site = await s.browser.call(
      'DELETE',
      `/api/companies/${s.company.slug}/sites/${s.site}`,
      {
        headers: { 'If-Match': '"1"' },
      },
    )
    expect(site.json()).toMatchObject({ code: 'has_documents' })
    const outId = out.json<{ id: string }>().id
    expect((await foreign.browser.call('DELETE', `${foreign.moves}/${outId}`)).statusCode).toBe(404)
    expect((await s.browser.call('DELETE', `${s.moves}/${outId}`)).statusCode).toBe(204)
    expect((await s.browser.call('DELETE', `${s.moves}/${outId}`)).statusCode).toBe(404)
    expect((await s.browser.call('GET', `${s.items}/${a.id}`)).json()).toMatchObject({
      stock: '100.000',
    })
  })

  it('loads the goods of a received order', async () => {
    const s = await scene()
    const a = (await s.browser.call('POST', s.items, { body: item() })).json<Item>()
    const supplier = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Edilizia Srl') returning id",
      [s.company.id],
    )
    const orders = `/api/companies/${s.company.slug}/purchase-orders`
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
    const loads = `${orders}/${orderId}/warehouse-loads`
    const body = { date: '2026-11-06', lines: [{ item_id: a.id, quantity: '50' }] }
    const early = await s.browser.call('POST', loads, { body })
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ code: 'invalid_transition' })
    for (const [status, version] of [
      ['sent', 1],
      ['received', 2],
    ] as const) {
      await s.browser.call('POST', `${orders}/${orderId}/status`, {
        body: { status },
        headers: { 'If-Match': `"${version}"` },
      })
    }
    const bad = await s.browser.call('POST', loads, {
      body: { date: 'x', lines: [{ item_id: crypto.randomUUID(), quantity: '0' }] },
    })
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'date',
      'lines.0.quantity',
    ])
    const foreign = await scene()
    const other = (await foreign.browser.call('POST', foreign.items, { body: item() })).json<Item>()
    const cross = await s.browser.call('POST', loads, {
      body: { date: '2026-11-06', lines: [{ item_id: other.id, quantity: '1' }] },
    })
    expect(Object.keys(cross.json<{ errors: object }>().errors)).toEqual(['lines.0.item_id'])
    expect(
      (
        await foreign.browser.call(
          'POST',
          `/api/companies/${foreign.company.slug}/purchase-orders/${orderId}/warehouse-loads`,
          { body },
        )
      ).statusCode,
    ).toBe(404)
    const loaded = await s.browser.call('POST', loads, { body })
    expect(loaded.statusCode).toBe(201)
    expect(loaded.json()).toMatchObject({
      data: [
        { kind: 'in', quantity: '50.000', purchase_order: { id: orderId, number: '2026/001' } },
      ],
    })
    expect((await s.browser.call('GET', `${s.items}/${a.id}`)).json()).toMatchObject({
      stock: '50.000',
    })
    const back = await s.browser.call('POST', `${orders}/${orderId}/status`, {
      body: { status: 'sent' },
      headers: { 'If-Match': '"3"' },
    })
    expect(back.statusCode).toBe(409)
    expect(back.json()).toMatchObject({ code: 'has_documents' })
  })

  it('needs the warehouse permissions', async () => {
    const owner = await scene()
    const created = (await owner.browser.call('POST', owner.items, { body: item() })).json<Item>()
    const movement = await owner.browser.call('POST', owner.moves, {
      body: move(owner, created.id),
    })
    const reader = await fx.user()
    const role = await fx.role(owner.company.id, 'Lettura', ['warehouse.view'])
    await fx.member(reader.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.email)
    const url = `${owner.items}/${created.id}`
    expect((await browser.call('GET', url)).statusCode).toBe(200)
    expect((await browser.call('GET', owner.moves)).statusCode).toBe(200)
    expect(
      (await browser.call('POST', owner.items, { body: item({ code: 'X' }) })).statusCode,
    ).toBe(403)
    expect(
      (await browser.call('POST', owner.moves, { body: move(owner, created.id) })).statusCode,
    ).toBe(403)
    const headers = { 'If-Match': '"1"' }
    expect((await browser.call('PUT', url, { body: item(), headers })).statusCode).toBe(403)
    expect((await browser.call('DELETE', url, { headers })).statusCode).toBe(403)
    expect(
      (await browser.call('DELETE', `${owner.moves}/${movement.json<{ id: string }>().id}`))
        .statusCode,
    ).toBe(403)
    const none = await scene(['clients.view'])
    expect((await none.browser.call('GET', none.items)).statusCode).toBe(403)
    expect((await none.browser.call('GET', none.moves)).statusCode).toBe(403)
    expect((await none.browser.call('GET', `${none.items}/${created.id}`)).statusCode).toBe(404)
  })
})
