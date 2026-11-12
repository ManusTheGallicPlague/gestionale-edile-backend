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

const ALL: Permission[] = ['sites.view', 'sites.create', 'sites.update']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/sites` }
}

type Scene = Awaited<ReturnType<typeof scene>>

function body(name: string, status: string, budget: string | null) {
  return {
    code: null,
    name,
    client_id: null,
    address: null,
    status,
    start_on: null,
    end_on: null,
    budget,
    notes: null,
  }
}

async function addSite(s: Scene, name: string, status: string, budget: string | null) {
  const res = await s.browser.call('POST', s.base, { body: body(name, status, budget) })
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
  await addSite(s, 'A da iniziare senza', 'planned', null)
  await addSite(s, 'B in corso senza', 'active', null)
  await addSite(s, 'C sospeso senza', 'suspended', null)
  await addSite(s, 'D chiuso senza', 'completed', null)
  await addSite(s, 'E in corso con', 'active', '25000.00')
  await addSite(s, 'F chiuso con', 'completed', '1000.50')
  await addSite(s, 'G in corso a zero', 'active', '0')
}

describe('sites without a budget', () => {
  it('filters open sites without a budget, and sites with one in any status', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[budget_missing]=true')).toEqual([
      'A da iniziare senza',
      'B in corso senza',
      'C sospeso senza',
    ])
    expect(await names(s, 'filter[budget_missing]=false')).toEqual([
      'E in corso con',
      'F chiuso con',
      'G in corso a zero',
    ])
    expect(await names(s, 'filter[budget_missing]=true&filter[status]=active')).toEqual([
      'B in corso senza',
    ])
    expect(await names(s, '')).toHaveLength(7)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=name&filter[budget_missing]=true`,
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
      const res = await s.browser.call('GET', `${url}?filter[budget_missing]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[budget_missing]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui senza', 'active', null)
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: { without_budget: number } }>().sites.without_budget).toBe(3)
    expect(await names(other, 'filter[budget_missing]=true')).toEqual(['Altrui senza'])
    expect(await names(s, 'search=Altrui&filter[budget_missing]=true')).toEqual([])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[budget_missing]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })

  it('follows updates of the budget', async () => {
    const s = await scene()
    const id = await addSite(s, 'H in corso', 'active', null)
    expect(await names(s, 'filter[budget_missing]=true')).toEqual(['H in corso'])
    const updated = await s.browser.call('PUT', `${s.base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: body('H in corso', 'active', '1500.00'),
    })
    expect(updated.statusCode).toBe(200)
    expect(await names(s, 'filter[budget_missing]=true')).toEqual([])
    expect(await names(s, 'filter[budget_missing]=false')).toEqual(['H in corso'])
  })
})
