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
  'estimates.view',
  'estimates.create',
  'estimates.update',
  'estimates.delete',
  'clients.delete',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

function estimateBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Rifacimento copertura',
    client_id: null,
    site_address: 'Via Roma 1, Torino',
    status: 'draft',
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Condominio Aurora', $2) returning id",
    [company.id, newVat()],
  )
  return {
    browser,
    company,
    clientId: client.rows[0]?.id ?? '',
    base: `/api/companies/${company.slug}/estimates`,
  }
}

type Listed = { data: { id: string; title: string }[]; meta: { total: number } }

describe('estimates', () => {
  it('creates, reads, updates with If-Match and deletes', async () => {
    const { browser, base, clientId } = await scene()
    const created = await browser.call('POST', base, {
      body: estimateBody({ client_id: clientId }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({
      status: 'draft',
      client: { id: clientId, name: 'Condominio Aurora' },
    })
    const url = `${base}/${created.json<{ id: string }>().id}`
    expect((await browser.call('GET', url)).statusCode).toBe(200)

    const body = estimateBody({ status: 'final', title: 'Copertura e grondaie' })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ status: 'final', client: null })
    expect(
      (await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(412)
    expect((await browser.call('PUT', url, { body })).statusCode).toBe(428)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      204,
    )
    expect((await browser.call('GET', url)).statusCode).toBe(404)
  })

  it.each([
    ['an empty title', { title: '' }, 'title'],
    ['an unknown status', { status: 'chiuso' }, 'status'],
    ['a client id that is not an id', { client_id: 'abc' }, 'client_id'],
    ['an address too long', { site_address: 'x'.repeat(301) }, 'site_address'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: estimateBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('lists with search, filters and sort', async () => {
    const { browser, base, clientId } = await scene()
    await browser.call('POST', base, { body: estimateBody({ title: 'Bagno' }) })
    await browser.call('POST', base, {
      body: estimateBody({ title: 'Facciata', client_id: clientId, status: 'final' }),
    })
    const titles = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((e) => e.title)
    expect(await titles('?sort=title')).toEqual(['Bagno', 'Facciata'])
    expect(await titles('?filter[status]=final')).toEqual(['Facciata'])
    expect(await titles(`?filter[client]=${clientId}`)).toEqual(['Facciata'])
    expect(await titles('?search=aurora')).toEqual(['Facciata'])
    expect((await browser.call('GET', `${base}?sort=prezzo`)).statusCode).toBe(422)
  })

  it('a client of another company cannot be linked; a linked client cannot be deleted', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('POST', mine.base, {
      body: estimateBody({ client_id: theirs.clientId }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { client_id: ['Cliente non trovato.'] } })

    await mine.browser.call('POST', mine.base, { body: estimateBody({ client_id: mine.clientId }) })
    const del = await mine.browser.call(
      'DELETE',
      `/api/companies/${mine.company.slug}/clients/${mine.clientId}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(del.statusCode).toBe(409)
  })

  it('permissions and isolation', async () => {
    const reader = await scene(['estimates.view'])
    expect(
      (await reader.browser.call('POST', reader.base, { body: estimateBody() })).statusCode,
    ).toBe(403)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)

    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: estimateBody() })
    const url = `${reader.base}/${created.json<{ id: string }>().id}`
    const full = await scene()
    const other = `${full.base}/${created.json<{ id: string }>().id}`
    const headers = { 'if-match': '"1"' }
    expect((await reader.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (await full.browser.call('PUT', other, { body: estimateBody(), headers })).statusCode,
    ).toBe(404)
    expect((await full.browser.call('DELETE', other, { headers })).statusCode).toBe(404)
  })
})
