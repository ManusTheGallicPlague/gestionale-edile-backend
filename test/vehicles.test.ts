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

const ALL: Permission[] = ['vehicles.view', 'vehicles.create', 'vehicles.update', 'vehicles.delete']

function vehicleBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Furgone cassonato',
    kind: 'vehicle',
    plate: null,
    model: null,
    hourly_cost: null,
    active: true,
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/vehicles` }
}

type Listed = { data: { id: string; name: string }[]; meta: { total: number } }

describe('vehicles', () => {
  it('creates, reads, updates with If-Match and deletes', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, {
      body: vehicleBody({ plate: 'ab 123-cd', model: 'Modello X', hourly_cost: '45' }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({ plate: 'AB123CD', hourly_cost: '45.00', active: true })
    const url = `${base}/${created.json<{ id: string }>().id}`
    expect((await browser.call('GET', url)).statusCode).toBe(200)

    const body = vehicleBody({ name: 'Escavatore 3,5 t', kind: 'machine', active: false })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ kind: 'machine', plate: null, active: false })
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
    ['an unknown kind', { kind: 'camion' }, 'kind'],
    ['a plate with symbols', { plate: 'AB*123' }, 'plate'],
    ['a plate too long', { plate: 'ABCDEFGHIJK' }, 'plate'],
    ['a cost with a comma', { hourly_cost: '45,00' }, 'hourly_cost'],
    ['active missing', { active: undefined }, 'active'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: vehicleBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('a plate is unique in the company, not across companies', async () => {
    const mine = await scene()
    const theirs = await scene()
    const body = vehicleBody({ plate: 'AB123CD' })
    expect((await mine.browser.call('POST', mine.base, { body })).statusCode).toBe(201)
    const twin = await mine.browser.call('POST', mine.base, {
      body: vehicleBody({ plate: 'ab 123 cd' }),
    })
    expect(twin.statusCode).toBe(422)
    expect(twin.json()).toMatchObject({ errors: { plate: [expect.any(String)] } })
    expect((await theirs.browser.call('POST', theirs.base, { body })).statusCode).toBe(201)
  })

  it('lists with search, filters and sort', async () => {
    const { browser, base } = await scene()
    await browser.call('POST', base, {
      body: vehicleBody({ name: 'Betoniera', kind: 'equipment' }),
    })
    await browser.call('POST', base, {
      body: vehicleBody({ name: 'Autocarro', plate: 'XY987ZW', active: false }),
    })
    const names = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((e) => e.name)
    expect(await names('')).toEqual(['Autocarro', 'Betoniera'])
    expect(await names('?sort=-name')).toEqual(['Betoniera', 'Autocarro'])
    expect(await names('?filter[kind]=equipment')).toEqual(['Betoniera'])
    expect(await names('?filter[active]=false')).toEqual(['Autocarro'])
    expect(await names('?search=xy987')).toEqual(['Autocarro'])
    expect((await browser.call('GET', `${base}?filter[kind]=camion`)).statusCode).toBe(422)
  })

  it('changes end up in the audit log', async () => {
    const { browser, base, company } = await scene()
    const created = await browser.call('POST', base, { body: vehicleBody() })
    const { rows } = await ctx.owner.query<{ entity: string; action: string }>(
      'select entity, action from public.audit_log where company_id = $1 and entity_id = $2',
      [company.id, created.json<{ id: string }>().id],
    )
    expect(rows).toEqual([{ entity: 'vehicle', action: 'create' }])
  })

  it('permissions and isolation', async () => {
    const reader = await scene(['vehicles.view'])
    expect(
      (await reader.browser.call('POST', reader.base, { body: vehicleBody() })).statusCode,
    ).toBe(403)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)

    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: vehicleBody() })
    const id = created.json<{ id: string }>().id
    expect((await blind.browser.call('GET', `${blind.base}/${id}`)).statusCode).toBe(404)
    const full = await scene()
    const other = `${full.base}/${id}`
    const headers = { 'if-match': '"1"' }
    expect((await reader.browser.call('GET', `${reader.base}/${id}`)).statusCode).toBe(404)
    expect(
      (await full.browser.call('PUT', other, { body: vehicleBody(), headers })).statusCode,
    ).toBe(404)
    expect((await full.browser.call('DELETE', other, { headers })).statusCode).toBe(404)
    expect((await full.browser.call('GET', full.base)).json<Listed>().meta.total).toBe(0)
  })
})
