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
})
