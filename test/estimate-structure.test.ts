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

const ALL: Permission[] = ['estimates.view', 'estimates.create', 'estimates.update']

type Chapter = { id: string; parent_id: string | null; position: number; version: string }
type Item = { id: string; chapter_id: string; position: number; unit_price: string }
type Measurement = { id: string; item_id: string; quantity: string; position: number }
type Structure = { chapters: Chapter[]; items: Item[]; measurements: Measurement[] }

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const estimate = await ctx.owner.query<{ id: string }>(
    "insert into public.estimates (company_id, title) values ($1, 'Ristrutturazione bagno') returning id",
    [company.id],
  )
  const estimateId = estimate.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/estimates/${estimateId}`
  const chapter = async (title: string, parent_id: string | null = null) => {
    const res = await browser.call('POST', `${base}/chapters`, {
      body: { code: null, title, parent_id },
    })
    expect(res.statusCode).toBe(201)
    return res.json<Chapter>()
  }
  return { browser, company, estimateId, base, chapter }
}

const itemBody = (chapter_id: string, overrides: Record<string, unknown> = {}) => ({
  chapter_id,
  code: 'TOS25_01.A03.001',
  description: 'Demolizione di pavimento in piastrelle',
  unit: 'm²',
  unit_price: '12.5',
  ...overrides,
})

describe('estimate structure', () => {
  it('builds a tree of chapters and items, in order', async () => {
    const { browser, base, chapter } = await scene()
    const demolizioni = await chapter('Demolizioni')
    const murature = await chapter('Murature')
    const interne = await chapter('Interne', murature.id)
    expect([demolizioni.position, murature.position, interne.position]).toEqual([0, 1, 0])
    expect(interne.parent_id).toBe(murature.id)

    const first = await browser.call('POST', `${base}/items`, { body: itemBody(demolizioni.id) })
    expect(first.statusCode).toBe(201)
    expect(first.headers.etag).toBe('"1"')
    expect(first.json()).toMatchObject({ unit_price: '12.50', position: 0, version: '"1"' })
    const second = await browser.call('POST', `${base}/items`, {
      body: itemBody(demolizioni.id, { code: null, unit_price: '0' }),
    })
    expect(second.json()).toMatchObject({ unit_price: '0.00', position: 1 })

    const tree = await browser.call('GET', `${base}/structure`)
    expect(tree.statusCode).toBe(200)
    const s = tree.json<Structure>()
    expect(s.chapters.map((c) => c.id)).toEqual([demolizioni.id, murature.id, interne.id])
    expect(s.items.map((i) => i.position)).toEqual([0, 1])
  })

  it('updates with If-Match and deletes a chapter with what it contains', async () => {
    const { browser, base, chapter } = await scene()
    const parent = await chapter('Impianti')
    const child = await chapter('Elettrico', parent.id)
    const item = await browser.call('POST', `${base}/items`, { body: itemBody(child.id) })
    const itemUrl = `${base}/items/${item.json<Item>().id}`

    const body = itemBody(child.id, { description: 'Punto luce', unit: 'cad', unit_price: '45' })
    const updated = await browser.call('PUT', itemUrl, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ unit_price: '45.00', unit: 'cad', version: '"2"' })
    expect(
      (await browser.call('PUT', itemUrl, { body, headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect((await browser.call('PUT', itemUrl, { body })).statusCode).toBe(428)

    const chapterUrl = `${base}/chapters/${parent.id}`
    const renamed = await browser.call('PUT', chapterUrl, {
      body: { code: 'A', title: 'Impianti tecnologici' },
      headers: { 'if-match': '"1"' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ code: 'A', parent_id: null, version: '"2"' })

    const del = await browser.call('DELETE', chapterUrl, { headers: { 'if-match': '"2"' } })
    expect(del.statusCode).toBe(204)
    const s = (await browser.call('GET', `${base}/structure`)).json<Structure>()
    expect(s).toEqual({ chapters: [], items: [], measurements: [] })
    expect(
      (await browser.call('DELETE', itemUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(404)
  })

  it('touches the estimate so it moves up in the list', async () => {
    const { estimateId, chapter } = await scene()
    const before = await ctx.owner.query<{ updated_at: Date }>(
      'select updated_at from public.estimates where id = $1',
      [estimateId],
    )
    await chapter('Finiture')
    const after = await ctx.owner.query<{ updated_at: Date }>(
      'select updated_at from public.estimates where id = $1',
      [estimateId],
    )
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]!.updated_at.getTime(),
    )
  })

  it('limits nesting to 4 levels', async () => {
    const { browser, base, chapter } = await scene()
    let parent: string | null = null
    for (const title of ['1', '2', '3', '4']) parent = (await chapter(title, parent)).id
    const res = await browser.call('POST', `${base}/chapters`, {
      body: { code: null, title: '5', parent_id: parent },
    })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['parent_id'])
  })

  it.each([
    ['an empty description', { description: ' ' }, 'description'],
    ['a missing unit', { unit: null }, 'unit'],
    ['a price as a JSON number', { unit_price: 12.5 }, 'unit_price'],
    ['a negative price', { unit_price: '-1.00' }, 'unit_price'],
    ['three decimals', { unit_price: '1.005' }, 'unit_price'],
    ['a chapter id that is not an id', { chapter_id: 'abc' }, 'chapter_id'],
    ['a code too long', { code: 'x'.repeat(51) }, 'code'],
  ])('refuses an item with %s', async (_label, overrides, field) => {
    const { browser, base, chapter } = await scene()
    const c = await chapter('Opere')
    const res = await browser.call('POST', `${base}/items`, { body: itemBody(c.id, overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('refuses a parent or chapter of another estimate or company', async () => {
    const mine = await scene()
    const theirs = await scene()
    const foreign = await theirs.chapter('Altrui')
    const sameCompany = await ctx.owner.query<{ id: string }>(
      "insert into public.estimates (company_id, title) values ($1, 'Altro computo') returning id",
      [mine.company.id],
    )
    const otherBase = `/api/companies/${mine.company.slug}/estimates/${sameCompany.rows[0]?.id}`
    const local = await mine.browser.call('POST', `${otherBase}/chapters`, {
      body: { code: null, title: 'Di un altro computo', parent_id: null },
    })
    for (const chapterId of [foreign.id, local.json<Chapter>().id]) {
      const sub = await mine.browser.call('POST', `${mine.base}/chapters`, {
        body: { code: null, title: 'Sotto', parent_id: chapterId },
      })
      expect(sub.statusCode).toBe(422)
      const item = await mine.browser.call('POST', `${mine.base}/items`, {
        body: itemBody(chapterId),
      })
      expect(item.statusCode).toBe(422)
      expect(item.json()).toMatchObject({ errors: { chapter_id: ['Capitolo non trovato.'] } })
    }
    // A chapter of another estimate cannot be edited through this one.
    const res = await mine.browser.call(
      'PUT',
      `${mine.base}/chapters/${local.json<Chapter>().id}`,
      {
        body: { code: null, title: 'Preso' },
        headers: { 'if-match': '"1"' },
      },
    )
    expect(res.statusCode).toBe(404)
  })

  it('permissions and isolation', async () => {
    const theirs = await scene()
    const c = await theirs.chapter('Scavi')
    const item = await theirs.browser.call('POST', `${theirs.base}/items`, { body: itemBody(c.id) })
    const itemId = item.json<Item>().id

    const reader = await scene(['estimates.view'])
    expect((await reader.browser.call('GET', `${reader.base}/structure`)).statusCode).toBe(200)
    expect(
      (
        await reader.browser.call('POST', `${reader.base}/chapters`, {
          body: { code: null, title: 'X', parent_id: null },
        })
      ).statusCode,
    ).toBe(403)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', `${blind.base}/structure`)).statusCode).toBe(404)

    // Another company's estimate, through my company's URL or theirs: always 404.
    const full = await scene()
    const sameIdMine = `/api/companies/${full.company.slug}/estimates/${theirs.estimateId}`
    const theirsUrl = theirs.base
    const headers = { 'if-match': '"1"' }
    expect((await full.browser.call('GET', `${sameIdMine}/structure`)).statusCode).toBe(404)
    expect((await full.browser.call('GET', `${theirsUrl}/structure`)).statusCode).toBe(404)
    expect(
      (
        await full.browser.call('PUT', `${full.base}/items/${itemId}`, {
          body: itemBody(c.id),
          headers,
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (await full.browser.call('DELETE', `${full.base}/chapters/${c.id}`, { headers })).statusCode,
    ).toBe(404)
    const still = (await theirs.browser.call('GET', `${theirs.base}/structure`)).json<Structure>()
    expect(still.items).toHaveLength(1)
  })

  describe('measurements', () => {
    async function withItem(permissions: Permission[] = ALL) {
      const sc = await scene(permissions)
      const c = await sc.chapter('Pavimenti')
      const item = await sc.browser.call('POST', `${sc.base}/items`, { body: itemBody(c.id) })
      return { ...sc, chapterId: c.id, itemId: item.json<Item>().id }
    }
    const row = (item_id: string, overrides: Record<string, unknown> = {}) => ({
      item_id,
      description: 'Bagno',
      equal_parts: null,
      length: '3.20',
      width: '2.5',
      height: null,
      ...overrides,
    })

    it('computes the quantity as the product of the factors present', async () => {
      const { browser, base, itemId } = await withItem()
      const add = async (overrides: Record<string, unknown>) => {
        const res = await browser.call('POST', `${base}/measurements`, {
          body: row(itemId, overrides),
        })
        expect(res.statusCode).toBe(201)
        return res.json<Measurement & Record<string, unknown>>()
      }
      const first = await add({})
      expect(first).toMatchObject({ quantity: '8.000', length: '3.200', width: '2.500' })
      expect(first.position).toBe(0)
      // A deduction: the door, negative.
      const door = await add({
        description: 'Porta',
        equal_parts: '-1',
        length: '0.8',
        width: '2.1',
      })
      expect(door).toMatchObject({ quantity: '-1.680', position: 1 })
      // Rounded to 3 decimals by the database, never through floats.
      const tiny = await add({ length: '0.333', width: '0.333' })
      expect(tiny.quantity).toBe('0.111')
      const weight = await add({ equal_parts: '12', length: null, width: null, height: '7.85' })
      expect(weight.quantity).toBe('94.200')

      const tree = (await browser.call('GET', `${base}/structure`)).json<Structure>()
      expect(tree.measurements.map((m) => m.quantity)).toEqual([
        '8.000',
        '-1.680',
        '0.111',
        '94.200',
      ])
    })

    it('updates with If-Match, deletes, and goes away with its item', async () => {
      const { browser, base, itemId } = await withItem()
      const created = await browser.call('POST', `${base}/measurements`, { body: row(itemId) })
      const url = `${base}/measurements/${created.json<Measurement>().id}`
      const body = row(itemId, { length: '4' })
      const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
      expect(updated.statusCode).toBe(200)
      expect(updated.headers.etag).toBe('"2"')
      expect(updated.json()).toMatchObject({ quantity: '10.000', version: '"2"' })
      expect(
        (await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })).statusCode,
      ).toBe(412)
      expect((await browser.call('DELETE', url)).statusCode).toBe(428)
      expect(
        (await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode,
      ).toBe(204)

      await browser.call('POST', `${base}/measurements`, { body: row(itemId) })
      const del = await browser.call('DELETE', `${base}/items/${itemId}`, {
        headers: { 'if-match': '"1"' },
      })
      expect(del.statusCode).toBe(204)
      expect(
        (await browser.call('GET', `${base}/structure`)).json<Structure>().measurements,
      ).toEqual([])
    })

    it.each([
      ['no factor at all', { length: null, width: null }, 'quantity'],
      ['a factor as a JSON number', { length: 3.2 }, 'length'],
      ['a comma as separator', { width: '2,5' }, 'width'],
      ['four decimals', { length: '1.0001' }, 'length'],
      ['ten integer digits', { length: '1234567890' }, 'length'],
      ['a missing factor', { height: undefined }, 'height'],
      ['a description too long', { description: 'x'.repeat(501) }, 'description'],
      ['an item id that is not an id', { item_id: 'abc' }, 'item_id'],
      [
        'a quantity that does not fit',
        { equal_parts: '999999999', length: '999999999', width: '999', height: null },
        'quantity',
      ],
    ])('refuses %s', async (_label, overrides, field) => {
      const { browser, base, itemId } = await withItem()
      const body: Record<string, unknown> = row(itemId, overrides)
      if ('height' in overrides && overrides.height === undefined) delete body.height
      const res = await browser.call('POST', `${base}/measurements`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
    })

    it('permissions and isolation', async () => {
      const theirs = await withItem()
      const created = await theirs.browser.call('POST', `${theirs.base}/measurements`, {
        body: row(theirs.itemId),
      })
      const measurementId = created.json<Measurement>().id
      const mine = await withItem()
      const res = await mine.browser.call('POST', `${mine.base}/measurements`, {
        body: row(theirs.itemId),
      })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ errors: { item_id: ['Voce non trovata.'] } })
      const headers = { 'if-match': '"1"' }
      const url = `${mine.base}/measurements/${measurementId}`
      expect(
        (await mine.browser.call('PUT', url, { body: row(mine.itemId), headers })).statusCode,
      ).toBe(404)
      expect((await mine.browser.call('DELETE', url, { headers })).statusCode).toBe(404)

      const reader = await scene(['estimates.view'])
      const denied = await reader.browser.call('POST', `${reader.base}/measurements`, {
        body: row(theirs.itemId),
      })
      expect(denied.statusCode).toBe(403)
    })
  })
})
