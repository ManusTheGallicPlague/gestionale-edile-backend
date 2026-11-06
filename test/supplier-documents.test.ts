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
  'suppliers.view',
  'suppliers.create',
  'suppliers.update',
  'suppliers.delete',
  'deadlines.view',
  'deadlines.update',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

/** An ISO day, counted from today in Italy. */
function day(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date())
  const date = new Date(`${today}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function documentBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'durc',
    description: null,
    issued_on: day(-10),
    expires_on: day(110),
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.suppliers (company_id, name, vat_number, subcontractor) values ($1, 'Sub', $2, true) returning id",
    [company.id, newVat()],
  )
  const supplier = rows[0]?.id ?? ''
  const suppliers = `/api/companies/${company.slug}/suppliers`
  return {
    browser,
    company,
    supplier,
    suppliers,
    base: `${suppliers}/${supplier}/documents`,
  }
}

type Doc = { id: string; kind: string; status: string; expires_on: string | null }

describe('documents in the deadline calendar', () => {
  type Deadline = {
    id: string
    title: string
    due_on: string
    kind: string
    status: string
    supplier_document_id: string | null
    supplier: { id: string } | null
  }
  const deadlinesOf = async (browser: Browser, slug: string) =>
    (await browser.call('GET', `/api/companies/${slug}/deadlines`)).json<{ data: Deadline[] }>()
      .data

  it('a document with an expiry gets a deadline that follows it', async () => {
    const { browser, base, company, supplier } = await scene()
    const created = await browser.call('POST', base, { body: documentBody() })
    const docId = created.json<Doc>().id
    let [deadline] = await deadlinesOf(browser, company.slug)
    expect(deadline).toMatchObject({
      title: 'DURC – Sub',
      due_on: day(110),
      kind: 'durc',
      status: 'open',
      supplier_document_id: docId,
      supplier: { id: supplier },
    })

    // Done, then the DURC is renewed: the deadline moves and opens again.
    const deadlines = `/api/companies/${company.slug}/deadlines`
    await browser.call('POST', `${deadlines}/${deadline?.id}/complete`, {
      headers: { 'if-match': '"1"' },
    })
    await browser.call('PUT', `${base}/${docId}`, {
      body: documentBody({ expires_on: day(230) }),
      headers: { 'if-match': '"1"' },
    })
    ;[deadline] = await deadlinesOf(browser, company.slug)
    expect(deadline).toMatchObject({ due_on: day(230), status: 'open' })

    // No expiry any more: no deadline.
    await browser.call('PUT', `${base}/${docId}`, {
      body: documentBody({ expires_on: null }),
      headers: { 'if-match': '"2"' },
    })
    expect(await deadlinesOf(browser, company.slug)).toEqual([])
  })

  it('deleting the document deletes its deadline', async () => {
    const { browser, base, company } = await scene()
    const created = await browser.call('POST', base, {
      body: documentBody({ kind: 'other', description: 'Patente a crediti' }),
    })
    const [deadline] = await deadlinesOf(browser, company.slug)
    expect(deadline).toMatchObject({ title: 'Patente a crediti – Sub', kind: 'other' })
    await browser.call('DELETE', `${base}/${created.json<Doc>().id}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(await deadlinesOf(browser, company.slug)).toEqual([])
  })
})

describe('supplier documents', () => {
  it('registers documents and computes their status from today', async () => {
    const { browser, base, supplier } = await scene()
    const cases = [
      [{ expires_on: day(-1) }, 'expired'],
      [{ expires_on: day(0) }, 'expiring'],
      [{ kind: 'insurance', expires_on: day(30) }, 'expiring'],
      [{ kind: 'chamber_extract', expires_on: day(31) }, 'valid'],
      [{ kind: 'other', description: 'Patente a crediti', expires_on: null }, 'no_expiry'],
    ] as const
    for (const [overrides, status] of cases) {
      const res = await browser.call('POST', base, {
        body: documentBody({ issued_on: null, ...overrides }),
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers.etag).toBe('"1"')
      expect(res.json()).toMatchObject({ status, supplier_id: supplier })
    }
    const list = await browser.call('GET', base)
    expect(list.statusCode).toBe(200)
    const data = list.json<{ data: Doc[] }>().data
    // By expiry, documents without one at the end.
    expect(data.map((d) => d.expires_on)).toEqual([day(-1), day(0), day(30), day(31), null])
  })

  it.each([
    ['an unknown kind', { kind: 'patente' }, 'kind'],
    ['other without a description', { kind: 'other', description: null }, 'description'],
    ['an impossible date', { expires_on: '2026-02-30' }, 'expires_on'],
    ['a date in another format', { issued_on: '30/11/2026' }, 'issued_on'],
    ['an expiry before the issue', { issued_on: day(0), expires_on: day(-1) }, 'expires_on'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: documentBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('updates with If-Match and deletes; stale is 412, missing is 428', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: documentBody() })
    const url = `${base}/${created.json<Doc>().id}`
    const body = documentBody({ expires_on: day(200), notes: 'Rinnovato' })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ expires_on: day(200), notes: 'Rinnovato' })

    const stale = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(stale.statusCode).toBe(412)
    expect((await browser.call('PUT', url, { body })).statusCode).toBe(428)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })).statusCode).toBe(
      412,
    )
    const del = await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })
    expect(del.statusCode).toBe(204)
    expect((await browser.call('GET', base)).json<{ data: Doc[] }>().data).toEqual([])
  })

  it('a supplier with documents cannot be deleted: 409 has_documents', async () => {
    const { browser, base, suppliers, supplier } = await scene()
    await browser.call('POST', base, { body: documentBody() })
    const res = await browser.call('DELETE', `${suppliers}/${supplier}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'has_documents' })
  })

  it('reading needs suppliers.view (404), writing suppliers.update (403)', async () => {
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)
    const reader = await scene(['suppliers.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    const res = await reader.browser.call('POST', reader.base, { body: documentBody() })
    expect(res.statusCode).toBe(403)
  })

  it('documents of another company, or of another supplier, are out of reach', async () => {
    const mine = await scene()
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: documentBody() })
    const docId = created.json<Doc>().id
    const headers = { 'if-match': '"1"' }

    // Their supplier through my company: 404.
    const viaMyCompany = `/api/companies/${mine.company.slug}/suppliers/${theirs.supplier}/documents`
    expect((await mine.browser.call('GET', viaMyCompany)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('POST', viaMyCompany, { body: documentBody() })).statusCode,
    ).toBe(404)
    // Their document under my supplier: 404, and it stays as it was.
    const underMine = `${mine.base}/${docId}`
    expect(
      (await mine.browser.call('PUT', underMine, { body: documentBody(), headers })).statusCode,
    ).toBe(404)
    expect((await mine.browser.call('DELETE', underMine, { headers })).statusCode).toBe(404)
    const still = await theirs.browser.call('GET', theirs.base)
    expect(still.json<{ data: Doc[] }>().data.map((d) => d.id)).toEqual([docId])
  })
})
