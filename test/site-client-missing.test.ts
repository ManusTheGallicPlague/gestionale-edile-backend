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

const ALL: Permission[] = ['sites.view', 'sites.create', 'sites.update']

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
  return {
    browser,
    company,
    clientId: client.rows[0]?.id ?? '',
    base: `/api/companies/${company.slug}/sites`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

function body(name: string, status: string, clientId: string | null) {
  return {
    code: null,
    name,
    client_id: clientId,
    address: null,
    status,
    start_on: null,
    end_on: null,
    budget: null,
    notes: null,
  }
}

async function addSite(s: Scene, name: string, status: string, withClient: boolean) {
  const res = await s.browser.call('POST', s.base, {
    body: body(name, status, withClient ? s.clientId : null),
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ id: string }>().id
}

async function names(s: Scene, query: string) {
  const res = await s.browser.call('GET', `${s.base}?sort=name&${query}`)
  expect(res.statusCode).toBe(200)
  const list = res.json<{ data: { name: string }[]; meta: { total: number } }>()
  expect(list.meta.total).toBe(list.data.length)
  return list.data.map((x) => x.name)
}

async function fill(s: Scene) {
  await addSite(s, 'A da iniziare senza', 'planned', false)
  await addSite(s, 'B in corso senza', 'active', false)
  await addSite(s, 'C sospeso senza', 'suspended', false)
  await addSite(s, 'D chiuso senza', 'completed', false)
  await addSite(s, 'E in corso con', 'active', true)
  await addSite(s, 'F chiuso con', 'completed', true)
}

describe('sites without a client', () => {
  it('filters open sites without a client, and sites with one in any status', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[client_missing]=true')).toEqual([
      'A da iniziare senza',
      'B in corso senza',
      'C sospeso senza',
    ])
    expect(await names(s, 'filter[client_missing]=false')).toEqual([
      'E in corso con',
      'F chiuso con',
    ])
    expect(await names(s, 'filter[client_missing]=true&filter[status]=suspended')).toEqual([
      'C sospeso senza',
    ])
    expect(await names(s, `filter[client_missing]=true&filter[client]=${s.clientId}`)).toEqual([])
    expect(await names(s, '')).toHaveLength(6)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=name&filter[client_missing]=true`,
    )
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes('senza')))).toEqual([
      'A da iniziare senza',
      'B in corso senza',
      'C sospeso senza',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[client_missing]=1`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[client_missing]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui senza', 'active', false)
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: { without_client: number } }>().sites.without_client).toBe(3)
    expect(await names(other, 'filter[client_missing]=true')).toEqual(['Altrui senza'])
    expect(await names(s, 'search=Altrui&filter[client_missing]=true')).toEqual([])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[client_missing]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })

  it('follows updates of the client', async () => {
    const s = await scene()
    const id = await addSite(s, 'H in corso', 'active', false)
    expect(await names(s, 'filter[client_missing]=true')).toEqual(['H in corso'])
    const updated = await s.browser.call('PUT', `${s.base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: body('H in corso', 'active', s.clientId),
    })
    expect(updated.statusCode).toBe(200)
    expect(await names(s, 'filter[client_missing]=true')).toEqual([])
    expect(await names(s, 'filter[client_missing]=false')).toEqual(['H in corso'])
    const closed = await s.browser.call('PUT', `${s.base}/${id}`, {
      headers: { 'if-match': '"2"' },
      body: body('H in corso', 'completed', null),
    })
    expect(closed.statusCode).toBe(200)
    expect(await names(s, 'filter[client_missing]=true')).toEqual([])
  })
})
