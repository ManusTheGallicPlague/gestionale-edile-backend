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
  return { browser, company, base: `/api/companies/${company.slug}/price-lists` }
}

const listBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Prezzario regionale',
  year: 2026,
  notes: null,
  ...overrides,
})
const itemBody = (overrides: Record<string, unknown> = {}) => ({
  code: '01.A01.A10',
  description: 'Scavo di sbancamento',
  unit: 'm³',
  unit_price: '8.5',
  ...overrides,
})

interface Item {
  id: string
  code: string
  unit_price: string
}

describe('price lists', () => {
  it('creates a list with items, searches, updates and deletes', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, { body: listBody() })
    expect(created.statusCode).toBe(201)
    const list = created.json<{ id: string; item_count: number }>()
    expect(list.item_count).toBe(0)
    await s.browser.call('POST', s.base, { body: listBody({ name: 'Prezzi interni', year: null }) })
    const lists = await s.browser.call('GET', `${s.base}?search=regio`)
    expect(lists.json<{ data: { id: string }[] }>().data.map((l) => l.id)).toEqual([list.id])

    const items = `${s.base}/${list.id}/items`
    const first = await s.browser.call('POST', items, { body: itemBody() })
    expect(first.statusCode).toBe(201)
    expect(first.json<Item>().unit_price).toBe('8.50')
    const second = await s.browser.call('POST', items, {
      body: itemBody({ code: '01.A02', description: 'Rinterro', unit_price: '3' }),
    })
    const dup = await s.browser.call('POST', items, { body: itemBody({ code: '01.a01.a10' }) })
    expect(dup.statusCode).toBe(422)
    expect(dup.json()).toMatchObject({ errors: { code: [expect.any(String)] } })
    for (const bad of [{ unit_price: '-1' }, { unit_price: 'x' }, { unit: '' }, { code: null }]) {
      expect((await s.browser.call('POST', items, { body: itemBody(bad) })).statusCode).toBe(422)
    }
    expect((await s.browser.call('GET', `${s.base}/${list.id}`)).json()).toMatchObject({
      item_count: 2,
    })
    const found = await s.browser.call('GET', `${items}?search=rinterro`)
    expect(found.json<{ data: Item[] }>().data.map((i) => i.code)).toEqual(['01.A02'])

    const itemUrl = `${items}/${second.json<Item>().id}`
    expect((await s.browser.call('PUT', itemUrl, { body: itemBody() })).statusCode).toBe(428)
    expect(
      (
        await s.browser.call('PUT', itemUrl, {
          body: itemBody({ code: '01.A01.A10' }),
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(422)
    const updated = await s.browser.call('PUT', itemUrl, {
      body: itemBody({ code: '01.A02', unit_price: '3.25' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Item>().unit_price).toBe('3.25')
    expect(
      (await s.browser.call('DELETE', itemUrl, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect(
      (await s.browser.call('DELETE', itemUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(204)

    const renamed = await s.browser.call('PUT', `${s.base}/${list.id}`, {
      body: listBody({ name: 'Prezzario regionale 2026', year: 1800 }),
      headers: { 'if-match': '"1"' },
    })
    expect(renamed.statusCode).toBe(422)
    const ok = await s.browser.call('PUT', `${s.base}/${list.id}`, {
      body: listBody({ name: 'Prezzario regionale 2026' }),
      headers: { 'if-match': '"1"' },
    })
    expect(ok.statusCode).toBe(200)
    expect(
      (await s.browser.call('DELETE', `${s.base}/${list.id}`, { headers: { 'if-match': '"2"' } }))
        .statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', items)).statusCode).toBe(404)
  })

  it('checks the permissions and keeps other companies out', async () => {
    const owner = await scene()
    const list = (await owner.browser.call('POST', owner.base, { body: listBody() })).json<{
      id: string
    }>()
    const item = (
      await owner.browser.call('POST', `${owner.base}/${list.id}/items`, { body: itemBody() })
    ).json<Item>()
    const itemUrl = `${owner.base}/${list.id}/items/${item.id}`

    const viewer = await fx.user()
    await fx.member(
      viewer.id,
      owner.company.id,
      await fx.role(owner.company.id, 'Vista', ['price_lists.view']),
    )
    const browser = new Browser(ctx.app)
    await browser.signIn(viewer.email)
    expect((await browser.call('GET', `${owner.base}/${list.id}/items`)).statusCode).toBe(200)
    expect((await browser.call('POST', owner.base, { body: listBody() })).statusCode).toBe(403)
    expect(
      (await browser.call('POST', `${owner.base}/${list.id}/items`, { body: itemBody() }))
        .statusCode,
    ).toBe(403)
    expect(
      (await browser.call('DELETE', itemUrl, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(403)
    expect(
      (await browser.call('DELETE', `${owner.base}/${list.id}`, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(403)

    const none = await fx.user()
    await fx.member(none.id, owner.company.id, await fx.role(owner.company.id, 'Nessuno', []))
    const blind = new Browser(ctx.app)
    await blind.signIn(none.email)
    expect((await blind.call('GET', owner.base)).statusCode).toBe(403)
    expect((await blind.call('GET', `${owner.base}/${list.id}`)).statusCode).toBe(404)
    expect((await blind.call('GET', `${owner.base}/${list.id}/items`)).statusCode).toBe(404)

    const other = await scene()
    const theirs = `${other.base}/${list.id}`
    expect((await other.browser.call('GET', theirs)).statusCode).toBe(404)
    expect((await other.browser.call('GET', `${theirs}/items`)).statusCode).toBe(404)
    expect(
      (await other.browser.call('POST', `${theirs}/items`, { body: itemBody() })).statusCode,
    ).toBe(404)
    expect(
      (
        await other.browser.call('PUT', `${theirs}/items/${item.id}`, {
          body: itemBody(),
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
    expect((await other.browser.call('GET', owner.base)).statusCode).toBe(404)
    // An item reached through another list of the same company is not found either.
    const second = (await owner.browser.call('POST', owner.base, { body: listBody() })).json<{
      id: string
    }>()
    expect(
      (
        await owner.browser.call('DELETE', `${owner.base}/${second.id}/items/${item.id}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
  })
})
