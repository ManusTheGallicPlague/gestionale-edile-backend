import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { isValidIban } from '../src/settings/input.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const IBAN = 'IT60X0542811101000000123456'

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

async function scene(permissions: Permission[] = ['settings.view', 'settings.update']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const url = `/api/companies/${company.slug}/settings/company`
  const vat = newVat()
  const body = (overrides: Record<string, unknown> = {}) => ({
    legal_name: 'Edilizia Prova S.r.l.',
    vat_number: vat,
    tax_code: null,
    rea: 'to-1234567',
    share_capital: '10000',
    street: 'Corso Francia 10',
    postal_code: '10143',
    city: 'Torino',
    province: 'to',
    country: 'IT',
    phone: '011 555 0000',
    email: 'Info@Prova.example.test',
    pec: null,
    iban: 'it60 x054 2811 1010 0000 0123 456',
    ...overrides,
  })
  return { browser, company, url, body, vat }
}

describe('company profile', () => {
  it('starts from the company name, is saved once with If-Match "0", then versioned', async () => {
    const { browser, company, url, body, vat } = await scene()
    const first = await browser.call('GET', url)
    expect(first.statusCode).toBe(200)
    expect(first.headers.etag).toBe('"0"')
    expect(first.json()).toMatchObject({
      legal_name: company.name,
      vat_number: null,
      country: 'IT',
      updated_at: null,
    })

    expect((await browser.call('PUT', url, { body: body() })).statusCode).toBe(428)
    const saved = await browser.call('PUT', url, { body: body(), headers: { 'if-match': '"0"' } })
    expect(saved.statusCode).toBe(200)
    expect(saved.headers.etag).toBe('"1"')
    expect(saved.json()).toMatchObject({
      legal_name: 'Edilizia Prova S.r.l.',
      vat_number: vat,
      rea: 'TO-1234567',
      share_capital: '10000.00',
      province: 'TO',
      email: 'info@prova.example.test',
      iban: IBAN,
    })
    // A second "first save" (another tab) does not overwrite.
    const again = await browser.call('PUT', url, { body: body(), headers: { 'if-match': '"0"' } })
    expect(again.statusCode).toBe(412)
    const updated = await browser.call('PUT', url, {
      body: body({ iban: null, share_capital: null }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ iban: null, share_capital: null })
    expect(
      (await browser.call('PUT', url, { body: body(), headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect((await browser.call('GET', url)).headers.etag).toBe('"2"')
  })

  it.each([
    ['no legal name', { legal_name: '  ' }, 'legal_name'],
    ['a wrong partita IVA', { vat_number: '01234567890' }, 'vat_number'],
    ['a wrong IBAN', { iban: 'IT60X0542811101000000123457' }, 'iban'],
    ['a short CAP', { postal_code: '101' }, 'postal_code'],
    ['capital as a number', { share_capital: 10000 }, 'share_capital'],
    ['negative capital', { share_capital: '-1' }, 'share_capital'],
    ['a missing field', { pec: undefined }, 'pec'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, url, body } = await scene()
    const res = await browser.call('PUT', url, {
      body: JSON.parse(JSON.stringify(body(overrides))) as object,
      headers: { 'if-match': '"0"' },
    })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('needs settings permissions and stays within the company', async () => {
    const viewer = await scene(['settings.view'])
    expect((await viewer.browser.call('GET', viewer.url)).statusCode).toBe(200)
    expect(
      (
        await viewer.browser.call('PUT', viewer.url, {
          body: viewer.body(),
          headers: { 'if-match': '"0"' },
        })
      ).statusCode,
    ).toBe(403)
    const none = await scene(['quotes.view'])
    expect((await none.browser.call('GET', none.url)).statusCode).toBe(403)
    const other = await scene()
    expect((await other.browser.call('GET', viewer.url)).statusCode).toBe(404)
    expect(
      (
        await other.browser.call('PUT', viewer.url, {
          body: other.body(),
          headers: { 'if-match': '"0"' },
        })
      ).statusCode,
    ).toBe(404)
    expect((await viewer.browser.call('GET', viewer.url)).json()).toMatchObject({
      updated_at: null,
    })
  })

  it('is printed on the quote PDF', async () => {
    const { browser, company, url, body, vat } = await scene([
      'settings.view',
      'settings.update',
      'quotes.view',
      'quotes.create',
    ])
    await browser.call('PUT', url, { body: body(), headers: { 'if-match': '"0"' } })
    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Cliente PDF', $2) returning id",
      [company.id, newVat()],
    )
    const quotes = `/api/companies/${company.slug}/quotes`
    const quote = await browser.call('POST', quotes, {
      body: {
        client_id: client.rows[0]?.id,
        subject: 'Prova',
        validity_days: 30,
        notes: null,
        terms: null,
      },
    })
    const pdf = await browser.call('GET', `${quotes}/${quote.json<{ id: string }>().id}/pdf`)
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('(Edilizia Prova S.r.l.)')
    expect(text).toContain(`(P. IVA ${vat})`)
    expect(text).toContain('(REA TO-1234567 \x96 Cap. soc. \x80 10.000,00 i.v.)')
    expect(text).toContain('(Corso Francia 10 \x96 10143 Torino \\(TO\\))')
    expect(text).toContain(`(Pagamento su IBAN ${IBAN})`)
  })
})

describe('numbering', () => {
  const year = Number(
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 4),
  )

  it('sets the next quote number, never down to a number already used', async () => {
    const { browser, company } = await scene([
      'settings.view',
      'settings.update',
      'quotes.view',
      'quotes.create',
      'quotes.update',
    ])
    const url = `/api/companies/${company.slug}/settings/numbering`
    const start = await browser.call('GET', url)
    expect(start.json()).toEqual({ quotes: { year, next_number: 1, next: `${year}/001` } })
    const set = (body: object) => browser.call('PUT', `${url}/quotes`, { body })
    const moved = await set({ year, next_number: 46 })
    expect(moved.statusCode).toBe(200)
    expect(moved.json()).toEqual({ quotes: { year, next_number: 46, next: `${year}/046` } })

    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Cliente', $2) returning id",
      [company.id, newVat()],
    )
    const quotes = `/api/companies/${company.slug}/quotes`
    const quote = await browser.call('POST', quotes, {
      body: {
        client_id: client.rows[0]?.id,
        subject: 'P',
        validity_days: 30,
        notes: null,
        terms: null,
      },
    })
    const sent = await browser.call('POST', `${quotes}/${quote.json<{ id: string }>().id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(sent.json()).toMatchObject({ number: `${year}/046` })

    const used = await set({ year, next_number: 46 })
    expect(used.statusCode).toBe(409)
    expect(used.json()).toMatchObject({ code: 'number_in_use' })
    // Lowering is fine as long as no number is reused.
    expect((await set({ year, next_number: 47 })).statusCode).toBe(200)
    expect((await set({ year, next_number: 100 })).statusCode).toBe(200)
    expect((await set({ year, next_number: 47 })).json()).toMatchObject({
      quotes: { next_number: 47 },
    })
    // Next year can be prepared; other years cannot.
    expect((await set({ year: year + 1, next_number: 5 })).json()).toMatchObject({
      quotes: { year: year + 1, next: `${year + 1}/005` },
    })
    expect((await browser.call('GET', url)).json()).toMatchObject({ quotes: { year } })
    for (const body of [
      { year: year + 2, next_number: 1 },
      { year, next_number: 0 },
      { year, next_number: '5' },
      {},
    ]) {
      expect((await set(body)).statusCode).toBe(422)
    }
  })

  it('needs settings permissions and stays within the company', async () => {
    const viewer = await scene(['settings.view'])
    const url = `/api/companies/${viewer.company.slug}/settings/numbering`
    expect((await viewer.browser.call('GET', url)).statusCode).toBe(200)
    expect(
      (await viewer.browser.call('PUT', `${url}/quotes`, { body: { year, next_number: 9 } }))
        .statusCode,
    ).toBe(403)
    const none = await scene(['quotes.view'])
    expect(
      (await none.browser.call('GET', `/api/companies/${none.company.slug}/settings/numbering`))
        .statusCode,
    ).toBe(403)
    const other = await scene()
    expect(
      (await other.browser.call('PUT', `${url}/quotes`, { body: { year, next_number: 9 } }))
        .statusCode,
    ).toBe(404)
    expect((await viewer.browser.call('GET', url)).json()).toMatchObject({
      quotes: { next_number: 1 },
    })
  })
})

describe('IBAN check digits', () => {
  it.each([
    [IBAN, true],
    ['GB82WEST12345698765432', true],
    ['IT60X054281110100000012345', false],
    ['GB82WEST12345698765433', false],
  ])('%s → %s', (iban, valid) => {
    expect(isValidIban(iban)).toBe(valid)
  })
})
