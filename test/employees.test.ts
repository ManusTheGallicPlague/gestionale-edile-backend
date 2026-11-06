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

const ALL: Permission[] = [
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.delete',
]

function employeeBody(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Mario',
    last_name: 'Rossi',
    tax_code: null,
    job_title: 'Muratore',
    phone: null,
    email: null,
    hired_on: null,
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
  return { browser, company, base: `/api/companies/${company.slug}/employees` }
}

type Listed = { data: { id: string; last_name: string }[]; meta: { total: number } }

describe('employees', () => {
  it('creates, reads, updates with If-Match and deletes', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, {
      body: employeeBody({
        tax_code: 'rss mra 80a01 h501u',
        email: 'Mario.Rossi@Example.test',
        phone: '+39 011 123456',
        hired_on: '2020-03-02',
        hourly_cost: '28.5',
      }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({
      tax_code: 'RSSMRA80A01H501U',
      email: 'mario.rossi@example.test',
      hired_on: '2020-03-02',
      hourly_cost: '28.50',
      active: true,
    })
    const url = `${base}/${created.json<{ id: string }>().id}`
    expect((await browser.call('GET', url)).statusCode).toBe(200)

    const body = employeeBody({ active: false })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ active: false, tax_code: null, hourly_cost: null })
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
    ['an empty first name', { first_name: ' ' }, 'first_name'],
    ['an empty last name', { last_name: '' }, 'last_name'],
    ['a wrong check letter', { tax_code: 'RSSMRA80A01H501A' }, 'tax_code'],
    ['a company tax code', { tax_code: '01234567890' }, 'tax_code'],
    ['a bad email', { email: 'mario@' }, 'email'],
    ['letters in the phone', { phone: 'chiamami' }, 'phone'],
    ['an impossible date', { hired_on: '2026-13-01' }, 'hired_on'],
    ['a cost with a comma', { hourly_cost: '28,50' }, 'hourly_cost'],
    ['a negative cost', { hourly_cost: '-1' }, 'hourly_cost'],
    ['active as text', { active: 'true' }, 'active'],
    ['a missing field', { notes: undefined }, 'notes'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: employeeBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('a tax code is unique in the company, not across companies', async () => {
    const mine = await scene()
    const theirs = await scene()
    const body = employeeBody({ tax_code: 'RSSMRA80A01H501U' })
    expect((await mine.browser.call('POST', mine.base, { body })).statusCode).toBe(201)
    const twin = await mine.browser.call('POST', mine.base, { body })
    expect(twin.statusCode).toBe(422)
    expect(twin.json()).toMatchObject({ errors: { tax_code: [expect.any(String)] } })
    expect((await theirs.browser.call('POST', theirs.base, { body })).statusCode).toBe(201)
  })

  it('lists with search, filters and sort', async () => {
    const { browser, base } = await scene()
    await browser.call('POST', base, {
      body: employeeBody({ first_name: 'Luca', last_name: 'Bianchi', job_title: 'Carpentiere' }),
    })
    await browser.call('POST', base, { body: employeeBody({ last_name: 'Verdi', active: false }) })
    const names = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((e) => e.last_name)
    expect(await names('')).toEqual(['Bianchi', 'Verdi'])
    expect(await names('?sort=-last_name')).toEqual(['Verdi', 'Bianchi'])
    expect(await names('?filter[active]=true')).toEqual(['Bianchi'])
    expect(await names('?filter[active]=false')).toEqual(['Verdi'])
    expect(await names('?search=carpent')).toEqual(['Bianchi'])
    expect(await names('?search=luca%20bianchi')).toEqual(['Bianchi'])
    expect(await names('?search=bianchi%20luca')).toEqual(['Bianchi'])
    expect((await browser.call('GET', `${base}?filter[active]=si`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${base}?sort=paga`)).statusCode).toBe(422)
  })

  it('changes end up in the audit log', async () => {
    const { browser, base, company } = await scene()
    const created = await browser.call('POST', base, { body: employeeBody() })
    const { rows } = await ctx.owner.query<{ entity: string; action: string }>(
      'select entity, action from public.audit_log where company_id = $1 and entity_id = $2',
      [company.id, created.json<{ id: string }>().id],
    )
    expect(rows).toEqual([{ entity: 'employee', action: 'create' }])
  })

  it('permissions and isolation', async () => {
    const reader = await scene(['employees.view'])
    expect(
      (await reader.browser.call('POST', reader.base, { body: employeeBody() })).statusCode,
    ).toBe(403)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(403)

    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: employeeBody() })
    const id = created.json<{ id: string }>().id
    expect((await blind.browser.call('GET', `${blind.base}/${id}`)).statusCode).toBe(404)
    const full = await scene()
    const other = `${full.base}/${id}`
    const headers = { 'if-match': '"1"' }
    expect((await reader.browser.call('GET', `${reader.base}/${id}`)).statusCode).toBe(404)
    expect(
      (await full.browser.call('PUT', other, { body: employeeBody(), headers })).statusCode,
    ).toBe(404)
    expect((await full.browser.call('DELETE', other, { headers })).statusCode).toBe(404)
    expect((await full.browser.call('GET', full.base)).json<Listed>().meta.total).toBe(0)
  })
})
