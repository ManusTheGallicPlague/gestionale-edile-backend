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

const ALL: Permission[] = [
  'deadlines.view',
  'deadlines.create',
  'deadlines.update',
  'deadlines.delete',
  'clients.view',
  'clients.delete',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

function deadlineBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'F24 di novembre',
    due_on: '2026-11-16',
    kind: 'tax',
    amount: '1234.50',
    client_id: null,
    supplier_id: null,
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Cliente Uno', $2) returning id",
    [company.id, newVat()],
  )
  const supplier = await ctx.owner.query<{ id: string }>(
    "insert into public.suppliers (company_id, name, vat_number) values ($1, 'Fornitore Uno', $2) returning id",
    [company.id, newVat()],
  )
  return {
    browser,
    company,
    clientId: client.rows[0]?.id ?? '',
    supplierId: supplier.rows[0]?.id ?? '',
    base: `/api/companies/${company.slug}/deadlines`,
  }
}

type Listed = {
  data: { id: string; title: string; due_on: string; amount: string | null }[]
  meta: { total: number }
}

describe('deadlines', () => {
  it('creates an open deadline; the amount comes back with two decimals', async () => {
    const { browser, base, supplierId } = await scene()
    const res = await browser.call('POST', base, {
      body: deadlineBody({ amount: '1234.5', kind: 'invoice_in', supplier_id: supplierId }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers.etag).toBe('"1"')
    expect(res.json()).toMatchObject({
      amount: '1234.50',
      due_on: '2026-11-16',
      status: 'open',
      done_at: null,
      client: null,
      supplier: { id: supplierId, name: 'Fornitore Uno' },
    })
    const cents = await ctx.owner.query<{ amount_cents: string }>(
      'select amount_cents::text from public.deadlines where id = $1',
      [res.json<{ id: string }>().id],
    )
    expect(cents.rows[0]?.amount_cents).toBe('123450')
  })

  it.each([
    ['an amount with a comma', { amount: '1234,50' }, 'amount'],
    ['an amount as a JSON number', { amount: 1234.5 }, 'amount'],
    ['a negative amount', { amount: '-5.00' }, 'amount'],
    ['three decimals', { amount: '1.005' }, 'amount'],
    ['an impossible date', { due_on: '2026-02-29' }, 'due_on'],
    ['an unknown kind', { kind: 'mutuo' }, 'kind'],
    ['an empty title', { title: ' ' }, 'title'],
    ['a client id that is not an id', { client_id: 'abc' }, 'client_id'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: deadlineBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('refuses both a client and a supplier, and subjects of another company', async () => {
    const mine = await scene()
    const theirs = await scene()
    const both = await mine.browser.call('POST', mine.base, {
      body: deadlineBody({ client_id: mine.clientId, supplier_id: mine.supplierId }),
    })
    expect(both.statusCode).toBe(422)
    for (const [field, value] of [
      ['client_id', theirs.clientId],
      ['supplier_id', theirs.supplierId],
    ] as const) {
      const res = await mine.browser.call('POST', mine.base, {
        body: deadlineBody({ [field]: value }),
      })
      expect(res.statusCode, field).toBe(422)
      expect(res.json()).toMatchObject({ errors: { [field]: ['Soggetto non trovato.'] } })
    }
  })

  it('lists by date range for the calendar, with filters and paging', async () => {
    const { browser, base, clientId } = await scene()
    for (const [title, due_on, kind, client_id] of [
      ['Ottobre', '2026-10-31', 'tax', null],
      ['Inizio mese', '2026-11-01', 'vehicle', null],
      ['Fattura cliente', '2026-11-15', 'invoice_out', clientId],
      ['Fine mese', '2026-11-30', 'tax', null],
      ['Dicembre', '2026-12-01', 'tax', null],
    ] as const) {
      await browser.call('POST', base, { body: deadlineBody({ title, due_on, kind, client_id }) })
    }
    const titles = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((d) => d.title)

    const november = '?filter[from]=2026-11-01&filter[to]=2026-11-30'
    expect(await titles(november)).toEqual(['Inizio mese', 'Fattura cliente', 'Fine mese'])
    expect(await titles(`${november}&sort=-due_on&filter[kind]=tax`)).toEqual(['Fine mese'])
    expect(await titles(`?filter[client]=${clientId}`)).toEqual(['Fattura cliente'])
    expect(await titles('?search=dicem')).toEqual(['Dicembre'])
    const page = await browser.call('GET', `${base}?per_page=2&page=3`)
    expect(page.json<Listed>().data.map((d) => d.title)).toEqual(['Dicembre'])
    expect(page.json()).toMatchObject({ meta: { total: 5, page: 3, per_page: 2 } })
  })

  it('refuses wrong list parameters with 422', async () => {
    const { browser, base } = await scene()
    for (const query of [
      'filter[from]=01/11/2026',
      'filter[from]=2026-11-30&filter[to]=2026-11-01',
      'filter[status]=chiusa',
      'filter[client]=abc',
      'sort=title',
    ]) {
      expect((await browser.call('GET', `${base}?${query}`)).statusCode, query).toBe(422)
    }
  })

  it('completes and reopens with If-Match, and filters by status', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: deadlineBody() })
    const url = `${base}/${created.json<{ id: string }>().id}`

    const done = await browser.call('POST', `${url}/complete`, { headers: { 'if-match': '"1"' } })
    expect(done.statusCode).toBe(200)
    expect(done.json()).toMatchObject({ status: 'done' })
    expect(done.json<{ done_at: string | null }>().done_at).not.toBeNull()
    expect((await browser.call('GET', `${base}?filter[status]=open`)).json<Listed>().data).toEqual(
      [],
    )
    const stale = await browser.call('POST', `${url}/reopen`, { headers: { 'if-match': '"1"' } })
    expect(stale.statusCode).toBe(412)
    expect((await browser.call('POST', `${url}/reopen`)).statusCode).toBe(428)
    const reopened = await browser.call('POST', `${url}/reopen`, {
      headers: { 'if-match': '"2"' },
    })
    expect(reopened.json()).toMatchObject({ status: 'open', done_at: null })
  })

  it('updates with If-Match and deletes', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: deadlineBody() })
    const url = `${base}/${created.json<{ id: string }>().id}`
    const updated = await browser.call('PUT', url, {
      body: deadlineBody({ amount: null, title: 'Senza importo' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ amount: null, title: 'Senza importo' })
    expect(updated.headers.etag).toBe('"2"')
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })).statusCode).toBe(
      412,
    )
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      204,
    )
    expect((await browser.call('GET', url)).statusCode).toBe(404)
  })

  it('a client with deadlines cannot be deleted', async () => {
    const { browser, base, company, clientId } = await scene()
    await browser.call('POST', base, { body: deadlineBody({ client_id: clientId }) })
    const res = await browser.call('DELETE', `/api/companies/${company.slug}/clients/${clientId}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'has_documents' })
  })

  it('permissions: view 403 on the list and 404 on one, writes 403', async () => {
    const owner = await scene()
    const created = await owner.browser.call('POST', owner.base, { body: deadlineBody() })
    const id = created.json<{ id: string }>().id

    const blindUser = await fx.user()
    await fx.member(blindUser.id, owner.company.id, await fx.role(owner.company.id, 'Nulla', []))
    const blind = new Browser(ctx.app)
    await blind.signIn(blindUser.email)
    expect((await blind.call('GET', owner.base)).statusCode).toBe(403)
    expect((await blind.call('GET', `${owner.base}/${id}`)).statusCode).toBe(404)

    const readerUser = await fx.user()
    await fx.member(
      readerUser.id,
      owner.company.id,
      await fx.role(owner.company.id, 'Lettura', ['deadlines.view']),
    )
    const reader = new Browser(ctx.app)
    await reader.signIn(readerUser.email)
    const headers = { 'if-match': '"1"' }
    expect((await reader.call('POST', owner.base, { body: deadlineBody() })).statusCode).toBe(403)
    const url = `${owner.base}/${id}`
    expect((await reader.call('PUT', url, { body: deadlineBody(), headers })).statusCode).toBe(403)
    expect((await reader.call('POST', `${url}/complete`, { headers })).statusCode).toBe(403)
    expect((await reader.call('DELETE', url, { headers })).statusCode).toBe(403)
  })

  it('a deadline of another company is 404 everywhere and stays untouched', async () => {
    const mine = await scene()
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: deadlineBody() })
    const id = created.json<{ id: string }>().id
    const url = `${mine.base}/${id}`
    const headers = { 'if-match': '"1"' }
    expect((await mine.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('PUT', url, { body: deadlineBody(), headers })).statusCode,
    ).toBe(404)
    expect((await mine.browser.call('POST', `${url}/complete`, { headers })).statusCode).toBe(404)
    expect((await mine.browser.call('DELETE', url, { headers })).statusCode).toBe(404)
    const still = await theirs.browser.call('GET', `${theirs.base}/${id}`)
    expect(still.headers.etag).toBe('"1"')
    expect((await mine.browser.call('GET', mine.base)).json<Listed>().meta.total).toBe(0)
  })
})
