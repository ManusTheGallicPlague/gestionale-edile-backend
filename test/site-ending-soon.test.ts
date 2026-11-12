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

/** A day relative to today in Italy, as YYYY-MM-DD. */
function day(offset: number) {
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

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
  await addSite(s, 'A da iniziare fine oggi', 'planned', today)
  await addSite(s, 'B in corso fine tra 7', 'active', day(7))
  await addSite(s, 'C sospeso fine tra 14', 'suspended', day(14))
  await addSite(s, 'D chiuso fine tra 7', 'completed', day(7))
  await addSite(s, 'E in corso fine ieri', 'active', day(-1))
  await addSite(s, 'F in corso fine tra 15', 'active', day(15))
  await addSite(s, 'G in corso senza fine', 'active', null)
}

describe('sites ending soon', () => {
  it('filters open sites ending from today to 14 days ahead, and all the others', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[ending_soon]=true')).toEqual([
      'A da iniziare fine oggi',
      'B in corso fine tra 7',
      'C sospeso fine tra 14',
    ])
    expect(await names(s, 'filter[ending_soon]=false')).toEqual([
      'D chiuso fine tra 7',
      'E in corso fine ieri',
      'F in corso fine tra 15',
      'G in corso senza fine',
    ])
    expect(await names(s, 'filter[ending_soon]=true&filter[status]=active')).toEqual([
      'B in corso fine tra 7',
    ])
    expect(await names(s, 'filter[ending_soon]=false&filter[past_end]=true')).toEqual([
      'E in corso fine ieri',
    ])
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call('GET', `${s.base}/export?sort=name&filter[ending_soon]=true`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes(' fine ')))).toEqual([
      'A da iniziare fine oggi',
      'B in corso fine tra 7',
      'C sospeso fine tra 14',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[ending_soon]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[ending_soon]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui fine tra 3', 'active', day(3))
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    const sites = res.json<{ sites: { ending_soon: number; past_end: number } }>().sites
    expect(sites.ending_soon).toBe(3)
    expect(sites.past_end).toBe(1)
    expect(await names(other, 'filter[ending_soon]=true')).toEqual(['Altrui fine tra 3'])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[ending_soon]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})
