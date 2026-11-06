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
