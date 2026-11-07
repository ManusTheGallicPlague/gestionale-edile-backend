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
  'sites.view',
  'sites.create',
  'sites.update',
  'sites.delete',
  'clients.delete',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

function siteBody(overrides: Record<string, unknown> = {}) {
  return {
    code: null,
    name: 'Ristrutturazione villetta',
    client_id: null,
    address: 'Via Roma 1, Torino',
    status: 'planned',
    start_on: null,
    end_on: null,
    budget: null,
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
    base: `/api/companies/${company.slug}/sites`,
  }
}

type Listed = { data: { id: string; name: string }[]; meta: { total: number } }

describe('sites', () => {
  it('creates, reads, updates with If-Match and deletes', async () => {
    const { browser, base, clientId } = await scene()
    const created = await browser.call('POST', base, {
      body: siteBody({
        code: 'C-2026-01',
        client_id: clientId,
        start_on: '2026-11-09',
        end_on: '2027-03-31',
        budget: '85000.5',
      }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({
      code: 'C-2026-01',
      status: 'planned',
      start_on: '2026-11-09',
      end_on: '2027-03-31',
      budget: '85000.50',
      client: { id: clientId, name: 'Condominio Aurora' },
    })
    const url = `${base}/${created.json<{ id: string }>().id}`
    expect((await browser.call('GET', url)).statusCode).toBe(200)

    const body = siteBody({ status: 'active', name: 'Villetta Bianchi' })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ status: 'active', client: null, budget: null })
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
    ['an empty name', { name: '' }, 'name'],
    ['an unknown status', { status: 'chiuso' }, 'status'],
    ['a client id that is not an id', { client_id: 'abc' }, 'client_id'],
    ['an impossible date', { start_on: '2026-02-30' }, 'start_on'],
    ['an end before the start', { start_on: '2026-05-01', end_on: '2026-04-30' }, 'end_on'],
    ['a budget with a comma', { budget: '1000,50' }, 'budget'],
    ['a negative budget', { budget: '-5' }, 'budget'],
    ['a budget as a JSON number', { budget: 1000.5 }, 'budget'],
    ['a missing field', { notes: undefined }, 'notes'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: siteBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('keeps the position on the map, unchanged when an update leaves it out', async () => {
    const { browser, base } = await scene()
    const plain = await browser.call('POST', base, { body: siteBody() })
    expect(plain.json()).toMatchObject({ location: null })

    const created = await browser.call('POST', base, {
      body: siteBody({ location: { latitude: '45.0703', longitude: '-7.686856' } }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      location: { latitude: '45.070300', longitude: '-7.686856' },
    })
    const url = `${base}/${created.json<{ id: string }>().id}`
    const kept = await browser.call('PUT', url, {
      body: siteBody({ name: 'Altro nome' }),
      headers: { 'if-match': '"1"' },
    })
    expect(kept.json()).toMatchObject({
      name: 'Altro nome',
      location: { latitude: '45.070300', longitude: '-7.686856' },
    })
    const moved = await browser.call('PUT', url, {
      body: siteBody({ location: { latitude: '-90', longitude: '180.000000' } }),
      headers: { 'if-match': '"2"' },
    })
    expect(moved.json()).toMatchObject({
      location: { latitude: '-90.000000', longitude: '180.000000' },
    })
    const cleared = await browser.call('PUT', url, {
      body: siteBody({ location: null }),
      headers: { 'if-match': '"3"' },
    })
    expect(cleared.json()).toMatchObject({ location: null })
    const listed = await browser.call('GET', base)
    expect(listed.statusCode).toBe(200)
  })

  it.each([
    ['a latitude over 90', { latitude: '90.000001', longitude: '7' }, 'location.latitude'],
    ['a longitude over 180', { latitude: '45', longitude: '-181' }, 'location.longitude'],
    ['a coordinate as a JSON number', { latitude: 45.07, longitude: '7' }, 'location.latitude'],
    ['a comma', { latitude: '45', longitude: '7,68' }, 'location.longitude'],
    ['too many decimals', { latitude: '45.0703121', longitude: '7' }, 'location.latitude'],
    ['only one coordinate', { latitude: '45' }, 'location.longitude'],
    ['a string', 'Torino', 'location'],
  ])('refuses a location with %s', async (_label, location, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: siteBody({ location }) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('the database refuses half a position or one out of range', async () => {
    const { company } = await scene()
    for (const [latitude, longitude] of [
      ['45', null],
      ['91', '7'],
    ]) {
      await expect(
        ctx.owner.query(
          "insert into public.sites (company_id, name, status, latitude, longitude) values ($1, 'X', 'planned', $2, $3)",
          [company.id, latitude, longitude],
        ),
      ).rejects.toThrow()
    }
  })

  it('codes are unique in the company, ignoring case', async () => {
    const mine = await scene()
    const theirs = await scene()
    expect(
      (await mine.browser.call('POST', mine.base, { body: siteBody({ code: 'C-1' }) })).statusCode,
    ).toBe(201)
    const twin = await mine.browser.call('POST', mine.base, { body: siteBody({ code: 'c-1' }) })
    expect(twin.statusCode).toBe(422)
    expect(twin.json()).toMatchObject({ errors: { code: [expect.any(String)] } })
    expect(
      (await theirs.browser.call('POST', theirs.base, { body: siteBody({ code: 'C-1' }) }))
        .statusCode,
    ).toBe(201)
  })

  it('lists with search, filters and sort', async () => {
    const { browser, base, clientId } = await scene()
    await browser.call('POST', base, {
      body: siteBody({ name: 'Bagno', code: 'B-7', start_on: '2026-03-01' }),
    })
    await browser.call('POST', base, {
      body: siteBody({
        name: 'Facciata',
        client_id: clientId,
        status: 'active',
        start_on: '2026-01-15',
      }),
    })
    const names = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((e) => e.name)
    expect(await names('?sort=name')).toEqual(['Bagno', 'Facciata'])
    expect(await names('?sort=start_on')).toEqual(['Facciata', 'Bagno'])
    expect(await names('?filter[status]=active')).toEqual(['Facciata'])
    expect(await names(`?filter[client]=${clientId}`)).toEqual(['Facciata'])
    expect(await names('?search=aurora')).toEqual(['Facciata'])
    expect(await names('?search=b-7')).toEqual(['Bagno'])
    expect((await browser.call('GET', `${base}?sort=prezzo`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${base}?filter[status]=chiuso`)).statusCode).toBe(422)
  })

  it('a client of another company cannot be linked; a linked client cannot be deleted', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('POST', mine.base, {
      body: siteBody({ client_id: theirs.clientId }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { client_id: ['Cliente non trovato.'] } })

    await mine.browser.call('POST', mine.base, { body: siteBody({ client_id: mine.clientId }) })
    const del = await mine.browser.call(
      'DELETE',
      `/api/companies/${mine.company.slug}/clients/${mine.clientId}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(del.statusCode).toBe(409)
  })

  it('changes end up in the audit log', async () => {
    const { browser, base, company } = await scene()
    const created = await browser.call('POST', base, { body: siteBody() })
    const id = created.json<{ id: string }>().id
    const { rows } = await ctx.owner.query<{ entity: string; action: string }>(
      'select entity, action from public.audit_log where company_id = $1 and entity_id = $2',
      [company.id, id],
    )
    expect(rows).toEqual([{ entity: 'site', action: 'create' }])
  })

  it('permissions and isolation', async () => {
    const reader = await scene(['sites.view'])
    expect((await reader.browser.call('POST', reader.base, { body: siteBody() })).statusCode).toBe(
      403,
    )
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)

    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: siteBody() })
    const id = created.json<{ id: string }>().id
    const blindOne = await blind.browser.call('GET', `${blind.base}/${id}`)
    expect(blindOne.statusCode).toBe(404)
    const full = await scene()
    const other = `${full.base}/${id}`
    const headers = { 'if-match': '"1"' }
    expect((await reader.browser.call('GET', `${reader.base}/${id}`)).statusCode).toBe(404)
    expect((await full.browser.call('PUT', other, { body: siteBody(), headers })).statusCode).toBe(
      404,
    )
    expect((await full.browser.call('DELETE', other, { headers })).statusCode).toBe(404)
    const listed = await full.browser.call('GET', full.base)
    expect(listed.json<Listed>().meta.total).toBe(0)
  })
})
