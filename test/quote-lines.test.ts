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

  it('exports the lines in CSV, in order, named like the PDF', async () => {
    const { browser, base, quoteUrl, company, quoteId } = await scene()
    const add = async (body: object) =>
      expect((await browser.call('POST', base, { body })).statusCode).toBe(201)
    await add(text('section', 'Copertura'))
    await add(item())
    await add(
      item({
        description: 'Guaina; doppio strato',
        quantity: '3',
        unit_price: '33.33',
        discount_percent: '12.5',
        vat_rate: 0,
        vat_nature: 'N6.7',
      }),
    )
    await add(text('text', '=Ponteggi esclusi.'))
    // A line of another company's quote never shows up.
    const theirs = await scene()
    await theirs.browser.call('POST', theirs.base, { body: item({ description: 'Loro' }) })

    const url = `${base}/export`
    const draft = await browser.call('GET', url)
    expect(draft.statusCode).toBe(200)
    expect(draft.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(draft.headers['content-disposition']).toBe('attachment; filename="preventivo-bozza.csv"')
    expect(draft.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Tipo;Descrizione;Unità;Quantità;Prezzo;Sconto %;Imponibile;IVA %;Natura IVA',
      'Sezione;Copertura;;;;;;;',
      'Voce;Rimozione del manto di copertura;m²;120,500;18,40;0,00;2217,20;10;',
      'Voce;"Guaina; doppio strato";m²;3,000;33,33;12,50;87,49;0;N6.7',
      "Testo;'=Ponteggi esclusi.;;;;;;;",
    ])
    expect(draft.body).not.toContain('Loro')

    // Once sent it has a number, and the file takes it, as the PDF does.
    const sent = await browser.call('POST', `${quoteUrl}/send`, { headers: { 'if-match': '"1"' } })
    expect(sent.statusCode).toBe(200)
    const number = sent.json<{ number: string }>().number
    const after = await browser.call('GET', url)
    expect(after.headers['content-disposition']).toBe(
      `attachment; filename="preventivo-${number.replace('/', '-')}.csv"`,
    )
    expect(after.body.trim().split('\r\n')).toHaveLength(5)

    // Without quotes.view, from another company, with a bad id and without a session.
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(404)
    const sameQuote = `/api/companies/${theirs.company.slug}/quotes/${quoteId}/lines/export`
    expect((await theirs.browser.call('GET', sameQuote)).statusCode).toBe(404)
    const bad = `/api/companies/${company.slug}/quotes/x/lines/export`
    expect((await browser.call('GET', bad)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })

  it('reorders all the lines at once, keeping content and versions', async () => {
    const { browser, base, quoteUrl } = await scene()
    const add = async (body: object) =>
      (await browser.call('POST', base, { body })).json<Line & { version: string }>()
    const section = await add(text('section', 'Copertura'))
    const first = await add(item())
    const note = await add(text('text', 'Ponteggi esclusi.'))
    const second = await add(item({ quantity: '2', unit_price: '10.00' }))
    const before = (await browser.call('GET', quoteUrl)).json<{ totals: unknown }>().totals

    const order = [section.id, second.id, note.id, first.id]
    const res = await browser.call('PUT', base, { body: { lines: order } })
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: (Line & { version: string })[] }>().data
    expect(data.map((l) => l.id)).toEqual(order)
    expect(data.map((l) => l.position)).toEqual([0, 1, 2, 3])
    expect(data.map((l) => l.version)).toEqual(['"1"', '"1"', '"1"', '"1"'])
    expect(data[1]).toMatchObject({ amount: '20.00' })
    const listed = (await browser.call('GET', base)).json<{ data: Line[] }>().data
    expect(listed.map((l) => l.id)).toEqual(order)
    expect((await browser.call('GET', quoteUrl)).json<{ totals: unknown }>().totals).toEqual(before)

    // A line added afterwards goes at the end, after the new order.
    expect((await add(text('text', 'Fine.'))).position).toBe(4)
  })

  it.each([
    ['a line missing', (ids: string[]) => ids.slice(1)],
    ['a line twice', (ids: string[]) => [...ids, ids[0]]],
    [
      'an unknown line',
      (ids: string[]) => [...ids.slice(1), '0b8f6a52-3c1e-4d7a-9f20-6f1b2c3d4e5f'],
    ],
    ['an id that is not a UUID', (ids: string[]) => [...ids.slice(1), 'riga']],
    ['no array', () => 'tutte'],
  ])('refuses a reordering with %s, changing nothing', async (_label, build) => {
    const { browser, base } = await scene()
    const ids: string[] = []
    for (const body of [item(), text('text', 'Nota'), item()]) {
      ids.push((await browser.call('POST', base, { body })).json<Line>().id)
    }
    const res = await browser.call('PUT', base, { body: { lines: build([...ids].reverse()) } })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['lines'])
    const listed = (await browser.call('GET', base)).json<{ data: Line[] }>().data
    expect(listed.map((l) => l.id)).toEqual(ids)
  })

  it('reordering: only drafts, with quotes.update, never across companies', async () => {
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: item() })
    const lineId = created.json<Line>().id
    const body = { lines: [lineId] }

    const mine = await scene()
    const sameQuote = `/api/companies/${mine.company.slug}/quotes/${theirs.quoteId}/lines`
    expect((await mine.browser.call('PUT', sameQuote, { body })).statusCode).toBe(404)
    // Their line id in my quote is unknown: 422, and their quote is untouched.
    expect((await mine.browser.call('PUT', mine.base, { body })).statusCode).toBe(422)

    const reader = await scene(['quotes.view'])
    expect(
      (await reader.browser.call('PUT', reader.base, { body: { lines: [] } })).statusCode,
    ).toBe(403)
    // Like the other writes on lines: 403 without quotes.update.
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('PUT', blind.base, { body: { lines: [] } })).statusCode).toBe(
      403,
    )
    expect((await new Browser(ctx.app).call('PUT', theirs.base, { body })).statusCode).toBe(401)
    expect((await theirs.browser.call('PUT', theirs.base, { body, csrf: false })).statusCode).toBe(
      403,
    )

    await theirs.browser.call('POST', `${theirs.quoteUrl}/send`, { headers: { 'if-match': '"1"' } })
    const sent = await theirs.browser.call('PUT', theirs.base, { body })
    expect(sent.statusCode).toBe(409)
    expect(sent.json()).toMatchObject({ code: 'quote_not_draft' })
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

  it('keeps the VAT nature of zero-rated lines, apart in the totals', async () => {
    const { browser, base, quoteUrl } = await scene()
    // Absent means null, as for the lines written before natures existed.
    const plain = await browser.call('POST', base, { body: item() })
    expect(plain.json()).toMatchObject({ vat_nature: null })
    const reverse = await browser.call('POST', base, {
      body: item({ vat_rate: 0, vat_nature: 'N6.7', quantity: '1', unit_price: '1000.00' }),
    })
    expect(reverse.statusCode).toBe(201)
    expect(reverse.json()).toMatchObject({ vat_rate: 0, vat_nature: 'N6.7', amount: '1000.00' })
    await browser.call('POST', base, {
      body: item({ vat_rate: 0, vat_nature: 'N6.3', quantity: '1', unit_price: '50.00' }),
    })
    await browser.call('POST', base, {
      body: item({ vat_rate: 0, vat_nature: null, quantity: '1', unit_price: '5.00' }),
    })
    const res = await browser.call('GET', quoteUrl)
    expect(res.json<{ totals: object }>().totals).toEqual({
      taxable: '3272.20',
      vat: [
        { rate: 10, nature: null, taxable: '2217.20', vat: '221.72' },
        { rate: 0, nature: null, taxable: '5.00', vat: '0.00' },
        { rate: 0, nature: 'N6.3', taxable: '50.00', vat: '0.00' },
        { rate: 0, nature: 'N6.7', taxable: '1000.00', vat: '0.00' },
      ],
      vat_total: '221.72',
      total: '3493.92',
    })

    // Changing the rate needs the nature dropped; it can be changed with PUT.
    const id = reverse.json<Line>().id
    const put = (body: object) =>
      browser.call('PUT', `${base}/${id}`, { body, headers: { 'if-match': '"1"' } })
    const withRate = await put(item({ vat_rate: 22, vat_nature: 'N6.7' }))
    expect(withRate.statusCode).toBe(422)
    expect(Object.keys(withRate.json<{ errors: object }>().errors)).toEqual(['vat_nature'])
    const unknown = await put(item({ vat_rate: 0, vat_nature: 'N6' }))
    expect(unknown.statusCode).toBe(422)
    expect(Object.keys(unknown.json<{ errors: object }>().errors)).toEqual(['vat_nature'])
    const onText = await browser.call('POST', base, {
      body: { ...text('text', 'Nota'), vat_nature: 'N6.7' },
    })
    expect(onText.statusCode).toBe(422)
    expect(Object.keys(onText.json<{ errors: object }>().errors)).toEqual(['vat_nature'])
    const changed = await put(item({ vat_rate: 0, vat_nature: 'N4' }))
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ vat_nature: 'N4' })
    const cleared = await browser.call('PUT', `${base}/${id}`, {
      body: item({ vat_rate: 22 }),
      headers: { 'if-match': '"2"' },
    })
    expect(cleared.json()).toMatchObject({ vat_rate: 22, vat_nature: null })
  })

  it('the database refuses a nature on a line with VAT', async () => {
    const { company, quoteId } = await scene()
    await expect(
      ctx.owner.query(
        `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
           unit_price_cents, discount_percent, vat_rate, vat_nature, position)
         values ($1, $2, 'item', 'x', 'm', 1, 100, 0, 22, 'N6.7', 0)`,
        [company.id, quoteId],
      ),
    ).rejects.toThrow(/quote_lines_vat_nature_zero_rate/)
  })

  it('a revision keeps the VAT nature of the lines', async () => {
    const { browser, base, quoteUrl } = await scene()
    await browser.call('POST', base, { body: item({ vat_rate: 0, vat_nature: 'N6.7' }) })
    const sent = await browser.call('POST', `${quoteUrl}/send`, { headers: { 'if-match': '"1"' } })
    expect(sent.statusCode).toBe(200)
    const revision = await browser.call('POST', `${quoteUrl}/revisions`)
    expect(revision.statusCode).toBe(201)
    expect(revision.json()).toMatchObject({
      totals: { vat: [{ rate: 0, nature: 'N6.7', taxable: '2217.20', vat: '0.00' }] },
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

    it('gives every item the VAT nature of a reverse charge', async () => {
      const { browser, company, url, body } = await estimateScene()
      const res = await browser.call('POST', url, {
        body: { ...body, vat_rate: 0, vat_nature: 'N6.7' },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({
        totals: {
          taxable: '133.20',
          vat: [{ rate: 0, nature: 'N6.7', vat: '0.00' }],
          total: '133.20',
        },
      })
      const lines = (
        await browser.call(
          'GET',
          `/api/companies/${company.slug}/quotes/${res.json<{ id: string }>().id}/lines`,
        )
      ).json<{ data: { kind: string; vat_nature: string | null }[] }>().data
      expect(lines.map((l) => [l.kind, l.vat_nature])).toEqual([
        ['section', null],
        ['item', 'N6.7'],
        ['section', null],
        ['item', 'N6.7'],
        ['section', null],
        ['item', 'N6.7'],
      ])
      const withVat = await browser.call('POST', url, {
        body: { ...body, vat_rate: 10, vat_nature: 'N6.7' },
      })
      expect(withVat.statusCode).toBe(422)
      expect(Object.keys(withVat.json<{ errors: object }>().errors)).toEqual(['vat_nature'])
      const unknown = await browser.call('POST', url, {
        body: { ...body, vat_rate: 0, vat_nature: 'N9' },
      })
      expect(unknown.statusCode).toBe(422)
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
