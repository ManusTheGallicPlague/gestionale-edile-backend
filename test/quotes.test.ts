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
  'quotes.view',
  'quotes.create',
  'quotes.update',
  'quotes.delete',
  'clients.delete',
]

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
  const clientId = client.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/quotes`
  const body = (overrides: Record<string, unknown> = {}) => ({
    client_id: clientId,
    subject: 'Rifacimento del tetto',
    validity_days: 30,
    notes: null,
    terms: 'Pagamento: 30% all’ordine, saldo a fine lavori.',
    ...overrides,
  })
  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await browser.call('POST', base, { body: body(overrides) })
    expect(res.statusCode).toBe(201)
    return res.json<Quote>()
  }
  return { browser, company, clientId, base, body, create }
}

type Quote = {
  id: string
  status: string
  number: string | null
  issue_date: string | null
  valid_until: string | null
}

const romeToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })

describe('quotes', () => {
  it('creates a draft without number, updates it with If-Match', async () => {
    const { browser, base, body, create } = await scene()
    const q = await create()
    expect(q).toMatchObject({
      status: 'draft',
      number: null,
      issue_date: null,
      valid_until: null,
      client: { name: 'Condominio Aurora' },
    })
    const url = `${base}/${q.id}`
    const updated = await browser.call('PUT', url, {
      body: body({ subject: 'Tetto e grondaie', validity_days: 60 }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ subject: 'Tetto e grondaie', validity_days: 60 })
    expect(
      (await browser.call('PUT', url, { body: body(), headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect((await browser.call('PUT', url, { body: body() })).statusCode).toBe(428)
  })

  it('numbers quotes when sent, per year, without gaps', async () => {
    const { browser, base, create } = await scene()
    const first = await create()
    const second = await create()
    const draft = await create()
    // Sent in the opposite order of creation: the number follows the sending.
    const s2 = await browser.call('POST', `${base}/${second.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s2.statusCode).toBe(200)
    const year = romeToday().slice(0, 4)
    expect(s2.json()).toMatchObject({ status: 'sent', number: `${year}/001` })
    const sent = s2.json<Quote>()
    expect(sent.issue_date).toBe(romeToday())
    const valid = new Date(`${romeToday()}T00:00:00Z`)
    valid.setUTCDate(valid.getUTCDate() + 30)
    expect(sent.valid_until).toBe(valid.toISOString().slice(0, 10))

    const s1 = await browser.call('POST', `${base}/${first.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s1.json()).toMatchObject({ number: `${year}/002` })
    // Sending again: no longer a draft.
    const again = await browser.call('POST', `${base}/${first.id}/send`, {
      headers: { 'if-match': '"2"' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'quote_not_draft' })
    // A stale send changes nothing and uses no number.
    const stale = await browser.call('POST', `${base}/${draft.id}/send`, {
      headers: { 'if-match': '"9"' },
    })
    expect(stale.statusCode).toBe(412)
    const s3 = await browser.call('POST', `${base}/${draft.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s3.json()).toMatchObject({ number: `${year}/003` })
  })

  it('gives distinct numbers to concurrent sends', async () => {
    const { browser, base, create } = await scene()
    const quotes = await Promise.all([1, 2, 3, 4, 5].map(() => create()))
    const results = await Promise.all(
      quotes.map((q) =>
        browser.call('POST', `${base}/${q.id}/send`, { headers: { 'if-match': '"1"' } }),
      ),
    )
    const numbers = results.map((r) => r.json<Quote>().number?.slice(5)).sort()
    expect(numbers).toEqual(['001', '002', '003', '004', '005'])
  })

  it('a sent quote cannot be edited or deleted; a draft can be deleted', async () => {
    const { browser, base, body, create } = await scene()
    const q = await create()
    await browser.call('POST', `${base}/${q.id}/send`, { headers: { 'if-match': '"1"' } })
    const put = await browser.call('PUT', `${base}/${q.id}`, {
      body: body(),
      headers: { 'if-match': '"2"' },
    })
    expect(put.statusCode).toBe(409)
    const del = await browser.call('DELETE', `${base}/${q.id}`, { headers: { 'if-match': '"2"' } })
    expect(del.statusCode).toBe(409)
    const draft = await create()
    expect(
      (await browser.call('DELETE', `${base}/${draft.id}`, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(204)
  })

  it('lists with search, filters and sort', async () => {
    const { browser, base, create } = await scene()
    await create({ subject: 'Bagno' })
    const f = await create({ subject: 'Facciata' })
    await browser.call('POST', `${base}/${f.id}/send`, { headers: { 'if-match': '"1"' } })
    const subjects = async (query: string) =>
      (await browser.call('GET', `${base}${query}`))
        .json<{ data: { subject: string }[] }>()
        .data.map((q) => q.subject)
    expect(await subjects('?filter[status]=sent')).toEqual(['Facciata'])
    expect(await subjects('?sort=number')).toEqual(['Facciata', 'Bagno'])
    expect(await subjects('?search=/001')).toEqual(['Facciata'])
    expect(await subjects('?search=aurora')).toHaveLength(2)
    expect((await browser.call('GET', `${base}?filter[status]=chiuso`)).statusCode).toBe(422)
  })

  it.each([
    ['no client', { client_id: null }, 'client_id'],
    ['an empty subject', { subject: '' }, 'subject'],
    ['zero days of validity', { validity_days: 0 }, 'validity_days'],
    ['days as text', { validity_days: '30' }, 'validity_days'],
    ['terms too long', { terms: 'x'.repeat(10001) }, 'terms'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base, body } = await scene()
    const res = await browser.call('POST', base, { body: body(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('a client with quotes cannot be deleted; another company’s client cannot be used', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('POST', mine.base, {
      body: mine.body({ client_id: theirs.clientId }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { client_id: ['Cliente non trovato.'] } })
    await mine.create()
    const del = await mine.browser.call(
      'DELETE',
      `/api/companies/${mine.company.slug}/clients/${mine.clientId}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(del.statusCode).toBe(409)
  })

  it('permissions and isolation', async () => {
    const reader = await scene(['quotes.view'])
    expect(
      (await reader.browser.call('POST', reader.base, { body: reader.body() })).statusCode,
    ).toBe(403)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)

    const theirs = await scene()
    const q = await theirs.create()
    const full = await scene()
    const other = `${full.base}/${q.id}`
    const headers = { 'if-match': '"1"' }
    expect((await full.browser.call('GET', other)).statusCode).toBe(404)
    expect((await full.browser.call('POST', `${other}/send`, { headers })).statusCode).toBe(404)
    expect((await full.browser.call('PUT', other, { body: full.body(), headers })).statusCode).toBe(
      404,
    )
    expect((await full.browser.call('DELETE', other, { headers })).statusCode).toBe(404)
    expect(
      (await reader.browser.call('POST', `${reader.base}/${q.id}/send`, { headers })).statusCode,
    ).toBe(403)
    const still = await theirs.browser.call('GET', `${theirs.base}/${q.id}`)
    expect(still.json()).toMatchObject({ status: 'draft', number: null })
  })

  it('records the outcome of a sent quote, and can undo it', async () => {
    const { browser, base, create } = await scene()
    const q = await create()
    const status = (value: unknown, version: string) =>
      browser.call('POST', `${base}/${q.id}/status`, {
        body: { status: value },
        headers: { 'if-match': version },
      })
    // A draft has no outcome: it must be sent first.
    const early = await status('accepted', '"1"')
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ code: 'invalid_transition' })
    await browser.call('POST', `${base}/${q.id}/send`, { headers: { 'if-match': '"1"' } })
    const accepted = await status('accepted', '"2"')
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ status: 'accepted' })
    const number = accepted.json<Quote>().number
    expect((await status('rejected', '"3"')).statusCode).toBe(409)
    expect((await status('sent', '"2"')).statusCode).toBe(412)
    const undone = await status('sent', '"3"')
    expect(undone.json()).toMatchObject({ status: 'sent', number })
    expect((await status('expired', '"4"')).json()).toMatchObject({ status: 'expired' })
    expect((await status('draft', '"5"')).statusCode).toBe(422)
    expect((await status('accepted', '"5"')).statusCode).toBe(409)
    // Another company or a reader cannot change it.
    const theirs = await scene()
    expect(
      (
        await theirs.browser.call('POST', `${theirs.base}/${q.id}/status`, {
          body: { status: 'accepted' },
          headers: { 'if-match': '"5"' },
        })
      ).statusCode,
    ).toBe(404)
    const reader = await scene(['quotes.view'])
    expect(
      (
        await reader.browser.call('POST', `${reader.base}/${q.id}/status`, {
          body: { status: 'accepted' },
          headers: { 'if-match': '"5"' },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('revises a sent quote: a linked draft that takes the same number with -R1, -R2', async () => {
    const { browser, base, create } = await scene()
    const q = await create({ subject: 'Tetto' })
    await browser.call('POST', `${base}/${q.id}/lines`, {
      body: {
        kind: 'item',
        description: 'Manto in coppi',
        unit: 'm²',
        quantity: '120.000',
        unit_price: '45.00',
        discount_percent: '0',
        vat_rate: 10,
      },
    })
    const revise = (id: string) => browser.call('POST', `${base}/${id}/revisions`)
    // A draft is changed, not revised.
    const early = await revise(q.id)
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ code: 'invalid_transition' })
    const sent = await browser.call('POST', `${base}/${q.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    const number = sent.json<Quote>().number ?? ''
    expect(sent.json()).toMatchObject({ revision: 0, revision_of: null })
    const other = await create()
    await browser.call('POST', `${base}/${other.id}/send`, { headers: { 'if-match': '"1"' } })

    const r1 = await revise(q.id)
    expect(r1.statusCode).toBe(201)
    expect(r1.headers.etag).toBe('"1"')
    const draft = r1.json<Quote & { totals: { total: string } }>()
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      revision: null,
      subject: 'Tetto',
      revision_of: { id: q.id, number },
      totals: { total: '5940.00' },
    })
    const lines = await browser.call('GET', `${base}/${draft.id}/lines`)
    expect(lines.json<{ data: unknown[] }>().data).toHaveLength(1)
    // The original does not change.
    expect((await browser.call('GET', `${base}/${q.id}`)).json()).toMatchObject({
      status: 'sent',
      number,
    })
    const s1 = await browser.call('POST', `${base}/${draft.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s1.statusCode).toBe(200)
    expect(s1.json()).toMatchObject({ status: 'sent', number: `${number}-R1`, revision: 1 })
    // A revision of the revision, and a second one of the original, follow on.
    const r2 = (await revise(draft.id)).json<Quote>()
    expect(r2).toMatchObject({ revision_of: { id: draft.id, number: `${number}-R1` } })
    const r3 = (await revise(q.id)).json<Quote>()
    const s3 = await browser.call('POST', `${base}/${r3.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s3.json()).toMatchObject({ number: `${number}-R2` })
    const s2 = await browser.call('POST', `${base}/${r2.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(s2.json()).toMatchObject({ number: `${number}-R3` })
    // Revisions use no new number.
    const next = await create()
    const sn = await browser.call('POST', `${base}/${next.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(sn.json<Quote>().number?.slice(5)).toBe('003')
  })

  it('does not revise an accepted quote; revisions need permissions and the same company', async () => {
    const { browser, base, create } = await scene()
    const q = await create()
    await browser.call('POST', `${base}/${q.id}/send`, { headers: { 'if-match': '"1"' } })
    await browser.call('POST', `${base}/${q.id}/status`, {
      body: { status: 'accepted' },
      headers: { 'if-match': '"2"' },
    })
    const accepted = await browser.call('POST', `${base}/${q.id}/revisions`)
    expect(accepted.statusCode).toBe(409)
    // Back to sent, then rejected: a rejected quote can be revised.
    await browser.call('POST', `${base}/${q.id}/status`, {
      body: { status: 'sent' },
      headers: { 'if-match': '"3"' },
    })
    await browser.call('POST', `${base}/${q.id}/status`, {
      body: { status: 'rejected' },
      headers: { 'if-match': '"4"' },
    })
    expect((await browser.call('POST', `${base}/${q.id}/revisions`)).statusCode).toBe(201)
    const theirs = await scene()
    expect((await theirs.browser.call('POST', `${theirs.base}/${q.id}/revisions`)).statusCode).toBe(
      404,
    )
    const reader = await scene(['quotes.view'])
    expect((await reader.browser.call('POST', `${reader.base}/${q.id}/revisions`)).statusCode).toBe(
      403,
    )
    const blind = await scene(['quotes.create'])
    expect((await blind.browser.call('POST', `${blind.base}/${q.id}/revisions`)).statusCode).toBe(
      404,
    )
  })
})
