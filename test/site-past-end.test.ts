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

/** Today in Italy, as the backend computes it. */
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/sites` }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function addSite(s: Scene, name: string, status: string, endOn: string | null) {
  const res = await s.browser.call('POST', s.base, {
    body: {
      code: null,
      name,
      client_id: null,
      address: null,
      status,
      start_on: null,
      end_on: endOn,
      budget: null,
      notes: null,
    },
  })
  expect(res.statusCode).toBe(201)
}

async function names(s: Scene, query: string) {
  const res = await s.browser.call('GET', `${s.base}?sort=name&${query}`)
  expect(res.statusCode).toBe(200)
  const body = res.json<{ data: { name: string }[]; meta: { total: number } }>()
  expect(body.meta.total).toBe(body.data.length)
  return body.data.map((x) => x.name)
}

async function fill(s: Scene) {
  await addSite(s, 'A da iniziare scaduto', 'planned', '2020-01-31')
  await addSite(s, 'B in corso scaduto', 'active', '2025-06-30')
  await addSite(s, 'C sospeso scaduto', 'suspended', '2024-02-29')
  await addSite(s, 'D chiuso scaduto', 'completed', '2025-06-30')
  await addSite(s, 'E in corso fine oggi', 'active', today)
  await addSite(s, 'F in corso fine futura', 'active', '2099-12-31')
  await addSite(s, 'G in corso senza fine', 'active', null)
}

describe('sites past their planned end', () => {
  it('filters open sites with the end before today, and all the others', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[past_end]=true')).toEqual([
      'A da iniziare scaduto',
      'B in corso scaduto',
      'C sospeso scaduto',
    ])
    expect(await names(s, 'filter[past_end]=false')).toEqual([
      'D chiuso scaduto',
      'E in corso fine oggi',
      'F in corso fine futura',
      'G in corso senza fine',
    ])
    expect(await names(s, 'filter[past_end]=true&filter[status]=active')).toEqual([
      'B in corso scaduto',
    ])
    expect(await names(s, '')).toHaveLength(7)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call('GET', `${s.base}/export?sort=name&filter[past_end]=true`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes('scaduto')))).toEqual([
      'A da iniziare scaduto',
      'B in corso scaduto',
      'C sospeso scaduto',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[past_end]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[past_end]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui scaduto', 'active', '2025-01-31')
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: { past_end: number } }>().sites.past_end).toBe(3)
    expect(await names(other, 'filter[past_end]=true')).toEqual(['Altrui scaduto'])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[past_end]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})
