import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['quotes.view', 'quotes.create', 'quotes.update']

type Line = { id: string; kind: string; amount: string | null; position: number }

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Condominio Aurora', $2) returning id",
    [company.id, newVat()],
  )
  const quote = await ctx.owner.query<{ id: string }>(
    "insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'Tetto') returning id",
    [company.id, client.rows[0]?.id],
  )
  const quoteId = quote.rows[0]?.id ?? ''
  const quoteUrl = `/api/companies/${company.slug}/quotes/${quoteId}`
  return { browser, company, quoteId, quoteUrl, base: `${quoteUrl}/lines` }
}

const item = (overrides: Record<string, unknown> = {}) => ({
  kind: 'item',
  description: 'Rimozione del manto di copertura',
  unit: 'm²',
  quantity: '120.5',
  unit_price: '18.40',
  discount_percent: '0',
  vat_rate: 10,
  ...overrides,
})
const text = (kind: 'text' | 'section', description: string) => ({
  kind,
  description,
  unit: null,
  quantity: null,
  unit_price: null,
  discount_percent: null,
  vat_rate: null,
})

describe('quote lines', () => {
  it('adds sections, text and priced lines in order, with amounts', async () => {
    const { browser, base } = await scene()
    const add = async (body: object) => {
      const res = await browser.call('POST', base, { body })
      expect(res.statusCode).toBe(201)
      return res.json<Line & Record<string, unknown>>()
    }
    expect(await add(text('section', 'Copertura'))).toMatchObject({ position: 0, amount: null })
    // 120.5 × 18.40 = 2217.20
    expect(await add(item())).toMatchObject({
      amount: '2217.20',
      quantity: '120.500',
      discount_percent: '0.00',
      vat_rate: 10,
    })
    // 3 × 33.33 × (1 − 12.5%) = 87.49125 → 87.49
    expect(
      await add(
        item({ quantity: '3', unit_price: '33.33', discount_percent: '12.5', vat_rate: 22 }),
      ),
    ).toMatchObject({ amount: '87.49' })
    expect(await add(text('text', 'Ponteggi esclusi.'))).toMatchObject({ position: 3 })
    const list = (await browser.call('GET', base)).json<{ data: Line[] }>().data
    expect(list.map((l) => l.kind)).toEqual(['section', 'item', 'item', 'text'])
  })

  it('updates with If-Match and deletes', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: item() })
    const url = `${base}/${created.json<Line>().id}`
    const body = item({ discount_percent: '100' })
    const res = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ amount: '0.00', version: '"2"' })
    expect(
      (await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect((await browser.call('DELETE', url)).statusCode).toBe(428)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      204,
    )
  })

  it('lines of a sent quote cannot change', async () => {
    const { browser, base, quoteUrl } = await scene()
    const created = await browser.call('POST', base, { body: item() })
    await browser.call('POST', `${quoteUrl}/send`, { headers: { 'if-match': '"1"' } })
    const add = await browser.call('POST', base, { body: item() })
    expect(add.statusCode).toBe(409)
    expect(add.json()).toMatchObject({ code: 'quote_not_draft' })
    const url = `${base}/${created.json<Line>().id}`
    expect(
      (await browser.call('PUT', url, { body: item(), headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(409)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })).statusCode).toBe(
      409,
    )
    expect((await browser.call('GET', base)).json<{ data: Line[] }>().data).toHaveLength(1)
  })

  it.each([
    ['an unknown kind', { kind: 'nota' }, 'kind'],
    ['an empty description', { description: ' ' }, 'description'],
    ['no unit', { unit: null }, 'unit'],
    ['a quantity as a number', { quantity: 3 }, 'quantity'],
    ['a price with a comma', { unit_price: '18,40' }, 'unit_price'],
    ['a discount over 100', { discount_percent: '100.01' }, 'discount_percent'],
    ['an unknown VAT rate', { vat_rate: 21 }, 'vat_rate'],
    ['a missing field', { vat_rate: undefined }, 'vat_rate'],
    ['a text line with a price', { kind: 'text' }, 'unit_price'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const body: Record<string, unknown> = item(overrides)
    if ('vat_rate' in overrides && overrides.vat_rate === undefined) delete body.vat_rate
    const res = await browser.call('POST', base, { body })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('permissions and isolation', async () => {
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: item() })
    const lineId = created.json<Line>().id
    const mine = await scene()
    const sameQuote = `/api/companies/${mine.company.slug}/quotes/${theirs.quoteId}/lines`
    expect((await mine.browser.call('GET', sameQuote)).statusCode).toBe(404)
    expect((await mine.browser.call('POST', sameQuote, { body: item() })).statusCode).toBe(404)
    const headers = { 'if-match': '"1"' }
    const viaMine = `${mine.base}/${lineId}`
    expect((await mine.browser.call('PUT', viaMine, { body: item(), headers })).statusCode).toBe(
      404,
    )
    expect((await mine.browser.call('DELETE', viaMine, { headers })).statusCode).toBe(404)
    const reader = await scene(['quotes.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    expect((await reader.browser.call('POST', reader.base, { body: item() })).statusCode).toBe(403)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)
    const still = (await theirs.browser.call('GET', theirs.base)).json<{ data: Line[] }>()
    expect(still.data).toHaveLength(1)
  })

  it('computes taxable, VAT per rate and total on the quote', async () => {
    const { browser, base, quoteUrl } = await scene()
    const empty = await browser.call('GET', quoteUrl)
    expect(empty.json()).toMatchObject({
      totals: { taxable: '0.00', vat: [], vat_total: '0.00', total: '0.00' },
    })
    // 10%: 120.5 × 18.40 = 2217.20 and 2 × 0.05 = 0.10 → 2217.30, VAT 221.73
    await browser.call('POST', base, { body: item() })
    await browser.call('POST', base, { body: item({ quantity: '2', unit_price: '0.05' }) })
    // 22%: 1 × 0.07 = 0.07, VAT 0.0154 → 0.02 on the rate total, not line by line
    await browser.call('POST', base, {
      body: item({ quantity: '1', unit_price: '0.07', vat_rate: 22 }),
    })
    await browser.call('POST', base, { body: text('text', 'Nota') })
    const res = await browser.call('GET', quoteUrl)
    expect(res.json()).toMatchObject({
      totals: {
        taxable: '2217.37',
        vat: [
          { rate: 22, taxable: '0.07', vat: '0.02' },
          { rate: 10, taxable: '2217.30', vat: '221.73' },
        ],
        vat_total: '221.75',
        total: '2439.12',
      },
    })
  })

  describe('from an estimate', () => {
    async function estimateScene(permissions: Permission[] = [...ALL, 'estimates.view']) {
      const sc = await scene(permissions)
      const q = (sql: string, params: unknown[]) =>
        ctx.owner.query<{ id: string }>(sql, params).then((r) => r.rows[0]?.id ?? '')
      const estimateId = await q(
        "insert into public.estimates (company_id, title) values ($1, 'Bagno') returning id",
        [sc.company.id],
      )
      const chapter = (
        title: string,
        code: string | null,
        parent: string | null,
        position: number,
      ) =>
        q(
          `insert into public.estimate_chapters
             (company_id, estimate_id, parent_id, code, title, position)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [sc.company.id, estimateId, parent, code, title, position],
        )
      const item = (
        chapterId: string,
        code: string | null,
        description: string,
        cents: number,
        position: number,
      ) =>
        q(
          `insert into public.estimate_items (company_id, estimate_id, chapter_id, code,
             description, unit, unit_price_cents, position)
           values ($1, $2, $3, $4, $5, 'm²', $6, $7) returning id`,
          [sc.company.id, estimateId, chapterId, code, description, cents, position],
        )
      // Inserted out of order on purpose: the quote follows positions, not insertion.
      const b = await chapter('Impianti', 'B', null, 1)
      const a = await chapter('Demolizioni', 'A', null, 0)
      const a1 = await chapter('Pavimenti', null, a, 0)
      const tiles = await item(a1, 'DEM.01', 'Rimozione piastrelle', 1850, 0)
      await item(a, null, 'Sgombero', 10000, 0)
      await item(b, 'IDR.10', 'Punto acqua', 12000, 0)
      await ctx.owner.query(
        `insert into public.estimate_measurements
           (company_id, estimate_id, item_id, length, width, position)
         values ($1, $2, $3, 3.2, 2.5, 0), ($1, $2, $3, -1, 0.8, 1)`,
        [sc.company.id, estimateId, tiles],
      )
      const clientId = await q('select client_id as id from public.quotes where id = $1', [
        sc.quoteId,
      ])
      const url = `/api/companies/${sc.company.slug}/estimates/${estimateId}/quote`
      const body = {
        client_id: clientId,
        subject: 'Ristrutturazione bagno',
        validity_days: 30,
        notes: null,
        terms: null,
        vat_rate: 10,
      }
      return { ...sc, estimateId, url, body }
    }

    it('turns chapters into sections and items into lines, in tree order', async () => {
      const { browser, company, url, body } = await estimateScene()
      const res = await browser.call('POST', url, { body })
      expect(res.statusCode).toBe(201)
      // 3.2 × 2.5 − 0.8 = 7.2 m² × 18.50 = 133.20; 0 × 100 = 0; 0 × 120 = 0
      expect(res.json()).toMatchObject({
        status: 'draft',
        number: null,
        totals: { taxable: '133.20', vat: [{ rate: 10, vat: '13.32' }], total: '146.52' },
      })
      const quoteId = res.json<{ id: string }>().id
      const lines = (
        await browser.call('GET', `/api/companies/${company.slug}/quotes/${quoteId}/lines`)
      ).json<{ data: (Line & Record<string, unknown>)[] }>().data
      expect(lines.map((l) => [l.kind, l.description, l.position])).toEqual([
        ['section', 'A Demolizioni', 0],
        ['item', 'Sgombero', 1],
        ['section', 'Pavimenti', 2],
        ['item', 'DEM.01 Rimozione piastrelle', 3],
        ['section', 'B Impianti', 4],
        ['item', 'IDR.10 Punto acqua', 5],
      ])
      expect(lines[3]).toMatchObject({
        unit: 'm²',
        quantity: '7.200',
        unit_price: '18.50',
        discount_percent: '0.00',
        vat_rate: 10,
        amount: '133.20',
      })
    })

    it('refuses a bad VAT rate and another company’s estimate; checks permissions', async () => {
      const mine = await estimateScene()
      const bad = await mine.browser.call('POST', mine.url, {
        body: { ...mine.body, vat_rate: 21 },
      })
      expect(bad.statusCode).toBe(422)
      expect(Object.keys(bad.json<{ errors: object }>().errors)).toEqual(['vat_rate'])

      const theirs = await estimateScene()
      const url = `/api/companies/${mine.company.slug}/estimates/${theirs.estimateId}/quote`
      expect((await mine.browser.call('POST', url, { body: mine.body })).statusCode).toBe(404)

      const noQuotes = await estimateScene(['quotes.view', 'estimates.view'])
      expect(
        (await noQuotes.browser.call('POST', noQuotes.url, { body: noQuotes.body })).statusCode,
      ).toBe(403)
      const noEstimates = await estimateScene(ALL)
      expect(
        (await noEstimates.browser.call('POST', noEstimates.url, { body: noEstimates.body }))
          .statusCode,
      ).toBe(404)
      const count = await ctx.owner.query<{ n: number }>(
        'select count(*)::int as n from public.quotes where company_id = $1',
        [mine.company.id],
      )
      expect(count.rows[0]?.n).toBe(1)
    })
  })
})
