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

type Chapter = {
  id: string
  parent_id: string | null
  position: number
  version: string
  amount: string
}
type Item = { id: string; chapter_id: string; position: number; unit_price: string }
type Measurement = { id: string; item_id: string; quantity: string; position: number }
type Structure = { total: string; chapters: Chapter[]; items: Item[]; measurements: Measurement[] }

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
  it('copies an item from a price list item of the same company', async () => {
    const s = await scene([...ALL, 'price_lists.view'])
    const chapter = await s.chapter('Scavi')
    const priceItem = async (companyId: string) => {
      const list = await ctx.owner.query<{ id: string }>(
        "insert into public.price_lists (company_id, name) values ($1, 'Interni') returning id",
        [companyId],
      )
      const item = await ctx.owner.query<{ id: string }>(
        `insert into public.price_list_items (company_id, price_list_id, code, description, unit,
           unit_price_cents) values ($1, $2, 'SC.01', 'Scavo di sbancamento', 'm³', 850)
         returning id`,
        [companyId, list.rows[0]?.id],
      )
      return item.rows[0]?.id ?? ''
    }
    const mine = await priceItem(s.company.id)
    const url = `${s.base}/items/from-price-list`
    const created = await s.browser.call('POST', url, {
      body: { chapter_id: chapter.id, price_list_item_id: mine },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      chapter_id: chapter.id,
      code: 'SC.01',
      description: 'Scavo di sbancamento',
      unit: 'm³',
      unit_price: '8.50',
      position: 0,
    })
    // The copy does not follow later changes of the price list.
    await ctx.owner.query(
      'update public.price_list_items set unit_price_cents = 999 where id = $1',
      [mine],
    )
    const structure = (await s.browser.call('GET', `${s.base}/structure`)).json<Structure>()
    expect(structure.items.map((i) => i.unit_price)).toEqual(['8.50'])

    const other = await fx.company()
    const theirs = await priceItem(other.id)
    const refused = await s.browser.call('POST', url, {
      body: { chapter_id: chapter.id, price_list_item_id: theirs },
    })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({ errors: { price_list_item_id: [expect.any(String)] } })
    expect(
      (await s.browser.call('POST', url, { body: { chapter_id: 'x', price_list_item_id: mine } }))
        .statusCode,
    ).toBe(422)

    const noLists = await scene()
    const ch = await noLists.chapter('Scavi')
    expect(
      (
        await noLists.browser.call('POST', `${noLists.base}/items/from-price-list`, {
          body: { chapter_id: ch.id, price_list_item_id: mine },
        })
      ).statusCode,
    ).toBe(403)
  })

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
    expect(s).toEqual({ total: '0.00', chapters: [], items: [], measurements: [] })
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

  describe('totals', () => {
    it('adds up items, chapters with their sub-chapters, and the estimate', async () => {
      const { browser, base, company, estimateId, chapter } = await scene()
      const opere = await chapter('Opere')
      const pavimenti = await chapter('Pavimenti', opere.id)
      const altro = await chapter('Altro')
      const item = async (chapterId: string, unit_price: string) =>
        (
          await browser.call('POST', `${base}/items`, {
            body: itemBody(chapterId, { unit_price }),
          })
        ).json<Item>().id
      const measure = (item_id: string, length: string, equal_parts: string | null = null) =>
        browser.call('POST', `${base}/measurements`, {
          body: { item_id, description: null, equal_parts, length, width: null, height: null },
        })

      // 3.333 × 0.15 € = 0.49995 € → 50 cents after rounding, never 49.995 through floats.
      const a = await item(pavimenti.id, '0.15')
      await measure(a, '3.333')
      // 10 + 2.5 − 1.5 = 11 m × 12.34 € = 135.74 €
      const b = await item(opere.id, '12.34')
      await measure(b, '10')
      await measure(b, '2.5')
      await measure(b, '1.5', '-1')
      // Only a deduction: negative amount.
      const c = await item(altro.id, '100')
      await measure(c, '0.5', '-1')
      // No measurements: zero.
      const empty = await item(altro.id, '99')

      const s = (await browser.call('GET', `${base}/structure`)).json<Structure>()
      const byItem = new Map(s.items.map((i) => [i.id, i as Item & Record<string, unknown>]))
      expect(byItem.get(a)).toMatchObject({ quantity: '3.333', amount: '0.50' })
      expect(byItem.get(b)).toMatchObject({ quantity: '11.000', amount: '135.74' })
      expect(byItem.get(c)).toMatchObject({ quantity: '-0.500', amount: '-50.00' })
      expect(byItem.get(empty)).toMatchObject({ quantity: '0.000', amount: '0.00' })
      const byChapter = new Map(s.chapters.map((ch) => [ch.id, ch.amount]))
      expect(byChapter.get(pavimenti.id)).toBe('0.50')
      expect(byChapter.get(opere.id)).toBe('136.24')
      expect(byChapter.get(altro.id)).toBe('-50.00')
      expect(s.total).toBe('86.24')

      // The same totals on the single chapter, on the item and on the estimate header.
      const renamed = await browser.call('PUT', `${base}/chapters/${opere.id}`, {
        body: { code: null, title: 'Opere edili' },
        headers: { 'if-match': '"1"' },
      })
      expect(renamed.json()).toMatchObject({ amount: '136.24' })
      const repriced = await browser.call('PUT', `${base}/items/${b}`, {
        body: itemBody(opere.id, { unit_price: '10' }),
        headers: { 'if-match': '"1"' },
      })
      expect(repriced.json()).toMatchObject({ quantity: '11.000', amount: '110.00' })
      const header = await browser.call('GET', base)
      expect(header.json()).toMatchObject({ total: '60.50' })
      const list = await browser.call('GET', `/api/companies/${company.slug}/estimates`)
      expect(list.json<{ data: { id: string; total: string }[] }>().data).toEqual([
        expect.objectContaining({ id: estimateId, total: '60.50' }),
      ])
    })
  })

  describe('bulk arrangement', () => {
    async function tree() {
      const sc = await scene()
      const a = await sc.chapter('A')
      const b = await sc.chapter('B')
      const a1 = await sc.chapter('A1', a.id)
      const item = async (chapterId: string, description: string) =>
        (
          await sc.browser.call('POST', `${sc.base}/items`, {
            body: itemBody(chapterId, { description }),
          })
        ).json<Item>().id
      const x = await item(a1.id, 'x')
      const y = await item(a1.id, 'y')
      const z = await item(b.id, 'z')
      // 3 × 12.50 € = 37.50 €, to follow z's amount when it moves.
      await sc.browser.call('POST', `${sc.base}/measurements`, {
        body: {
          item_id: z,
          description: null,
          equal_parts: null,
          length: '3',
          width: null,
          height: null,
        },
      })
      const etag = (await sc.browser.call('GET', `${sc.base}/structure`)).headers.etag as string
      return { ...sc, a, b, a1, x, y, z, etag }
    }

    it('moves and reorders chapters and items, with the tree version', async () => {
      const { browser, base, a, b, a1, x, y, z, etag } = await tree()
      // B first, A1 moves under B, y before x, z moves into A1.
      const body = {
        chapters: [
          { id: b.id, parent_id: null },
          { id: a.id, parent_id: null },
          { id: a1.id, parent_id: b.id },
        ],
        items: [
          { id: y, chapter_id: a1.id },
          { id: z, chapter_id: a1.id },
          { id: x, chapter_id: a1.id },
        ],
      }
      const res = await browser.call('PUT', `${base}/structure`, {
        body,
        headers: { 'if-match': etag },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers.etag).not.toBe(etag)
      const s = res.json<Structure>()
      const chapter = new Map(s.chapters.map((c) => [c.id, c]))
      expect(chapter.get(b.id)).toMatchObject({ parent_id: null, position: 0 })
      expect(chapter.get(a.id)).toMatchObject({ parent_id: null, position: 1 })
      expect(chapter.get(a1.id)).toMatchObject({ parent_id: b.id, position: 0, amount: '37.50' })
      expect(chapter.get(b.id)?.amount).toBe('37.50')
      expect(chapter.get(a.id)?.amount).toBe('0.00')
      expect(s.items.map((i) => [i.id, i.chapter_id, i.position])).toEqual([
        [y, a1.id, 0],
        [z, a1.id, 1],
        [x, a1.id, 2],
      ])
      // The old version is stale now.
      const again = await browser.call('PUT', `${base}/structure`, {
        body,
        headers: { 'if-match': etag },
      })
      expect(again.statusCode).toBe(412)
      expect((await browser.call('PUT', `${base}/structure`, { body })).statusCode).toBe(428)
    })

    it('any change in the tree changes its version', async () => {
      const { browser, base, a, etag } = await tree()
      await browser.call('PUT', `${base}/chapters/${a.id}`, {
        body: { code: null, title: 'A rinominato' },
        headers: { 'if-match': '"1"' },
      })
      const after = (await browser.call('GET', `${base}/structure`)).headers.etag
      expect(after).not.toBe(etag)
    })

    it.each([
      [
        'a missing chapter',
        (t: Awaited<ReturnType<typeof tree>>) => ({ drop: t.a1.id }),
        'chapters',
      ],
      [
        'a cycle',
        (t: Awaited<ReturnType<typeof tree>>) => ({ cycle: [t.a.id, t.a1.id] }),
        'chapters',
      ],
      ['an item twice', (t: Awaited<ReturnType<typeof tree>>) => ({ twice: t.x }), 'items'],
      ['a foreign item', () => ({ foreign: true }), 'items'],
      ['too deep', () => ({ deep: true }), 'chapters'],
    ])('refuses %s', async (_label, how, field) => {
      const t = await tree()
      const change = how(t) as {
        drop?: string
        cycle?: string[]
        twice?: string
        foreign?: boolean
        deep?: boolean
      }
      let chapters = [
        { id: t.a.id, parent_id: null as string | null },
        { id: t.b.id, parent_id: null as string | null },
        { id: t.a1.id, parent_id: t.a.id as string | null },
      ]
      let items = [
        { id: t.x, chapter_id: t.a1.id },
        { id: t.y, chapter_id: t.a1.id },
        { id: t.z, chapter_id: t.b.id },
      ]
      if (change.drop) chapters = chapters.filter((c) => c.id !== change.drop)
      if (change.cycle) chapters[0] = { id: t.a.id, parent_id: t.a1.id }
      if (change.twice) items = [...items, { id: change.twice, chapter_id: t.b.id }]
      if (change.foreign) {
        const other = await tree()
        items = [...items.slice(0, 2), { id: other.z, chapter_id: t.b.id }]
      }
      if (change.deep) {
        // A → A1 → B → (new C, D) makes five levels.
        const c = await t.chapter('C')
        const d = await t.chapter('D')
        const etag = (await t.browser.call('GET', `${t.base}/structure`)).headers.etag as string
        t.etag = etag
        chapters = [
          { id: t.a.id, parent_id: null },
          { id: t.a1.id, parent_id: t.a.id },
          { id: t.b.id, parent_id: t.a1.id },
          { id: c.id, parent_id: t.b.id },
          { id: d.id, parent_id: c.id },
        ]
      }
      const res = await t.browser.call('PUT', `${t.base}/structure`, {
        body: { chapters, items },
        headers: { 'if-match': t.etag },
      })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
      // Nothing changed.
      const s = (await t.browser.call('GET', `${t.base}/structure`)).json<Structure>()
      expect(s.items.find((i) => i.id === t.z)?.chapter_id).toBe(t.b.id)
    })

    it('permissions and isolation', async () => {
      const theirs = await tree()
      const mine = await scene()
      const body = { chapters: [], items: [] }
      // Another company's estimate through my company: 404, theirs untouched.
      const url = `/api/companies/${mine.company.slug}/estimates/${theirs.estimateId}/structure`
      expect(
        (await mine.browser.call('PUT', url, { body, headers: { 'if-match': theirs.etag } }))
          .statusCode,
      ).toBe(404)
      const reader = await scene(['estimates.view'])
      expect(
        (
          await reader.browser.call('PUT', `${reader.base}/structure`, {
            body,
            headers: { 'if-match': '"1"' },
          })
        ).statusCode,
      ).toBe(403)
      const s = (await theirs.browser.call('GET', `${theirs.base}/structure`)).json<Structure>()
      expect(s.chapters).toHaveLength(3)
    })
  })

  describe('duplication', () => {
    it('copies header and tree with new ids, as a draft', async () => {
      const { browser, base, company, estimateId, chapter } = await scene([
        ...ALL,
        'estimates.delete',
      ])
      await ctx.owner.query(
        "update public.estimates set status = 'final', title = $2 where id = $1",
        [estimateId, 'T'.repeat(200)],
      )
      const a = await chapter('A')
      const a1 = await chapter('A1', a.id)
      const item = await browser.call('POST', `${base}/items`, { body: itemBody(a1.id) })
      const itemId = item.json<Item>().id
      await browser.call('POST', `${base}/measurements`, {
        body: {
          item_id: itemId,
          description: 'Bagno',
          equal_parts: '2',
          length: '3',
          width: null,
          height: null,
        },
      })
      const original = (await browser.call('GET', `${base}/structure`)).json<Structure>()

      const res = await browser.call('POST', `${base}/duplicate`)
      expect(res.statusCode).toBe(201)
      expect(res.headers.etag).toBe('"1"')
      const copy = res.json<{ id: string; title: string; status: string; total: string }>()
      expect(copy.id).not.toBe(estimateId)
      expect(copy).toMatchObject({ status: 'draft', total: '75.00' })
      expect(copy.title).toHaveLength(200)
      expect(copy.title.endsWith(' (copia)')).toBe(true)

      const copyBase = `/api/companies/${company.slug}/estimates/${copy.id}`
      const s = (await browser.call('GET', `${copyBase}/structure`)).json<Structure>()
      expect(s.total).toBe(original.total)
      const strip = (x: Structure) => ({
        chapters: x.chapters.map((c) => ({ ...c, id: '', parent_id: c.parent_id ? 'p' : null })),
        items: x.items.map((i) => ({ ...i, id: '', chapter_id: '' })),
        measurements: x.measurements.map((m) => ({ ...m, id: '', item_id: '' })),
      })
      expect(strip(s)).toEqual(strip(original))
      const newIds = [...s.chapters, ...s.items, ...s.measurements].map((x) => x.id)
      const oldIds = [...original.chapters, ...original.items, ...original.measurements].map(
        (x) => x.id,
      )
      expect(newIds.some((id) => oldIds.includes(id))).toBe(false)
      const sub = s.chapters.find((c) => c.parent_id !== null)
      expect(s.chapters.map((c) => c.id)).toContain(sub?.parent_id)

      // The copy is independent: deleting the original leaves it whole.
      const del = await browser.call('DELETE', base, { headers: { 'if-match': '"1"' } })
      expect(del.statusCode).toBe(204)
      const after = (await browser.call('GET', `${copyBase}/structure`)).json<Structure>()
      expect(after.measurements).toHaveLength(1)
    })

    it('permissions and isolation', async () => {
      const theirs = await scene()
      const mine = await scene()
      const url = `/api/companies/${mine.company.slug}/estimates/${theirs.estimateId}/duplicate`
      expect((await mine.browser.call('POST', url)).statusCode).toBe(404)
      const reader = await scene(['estimates.view'])
      expect((await reader.browser.call('POST', `${reader.base}/duplicate`)).statusCode).toBe(403)
      const blind = await scene(['estimates.create'])
      expect((await blind.browser.call('POST', `${blind.base}/duplicate`)).statusCode).toBe(404)
      const count = await ctx.owner.query<{ n: number }>(
        'select count(*)::int as n from public.estimates where company_id = $1',
        [mine.company.id],
      )
      expect(count.rows[0]?.n).toBe(1)
    })
  })
})
