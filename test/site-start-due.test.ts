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

async function addSite(s: Scene, name: string, status: string, startOn: string | null) {
  const res = await s.browser.call('POST', s.base, {
    body: {
      code: null,
      name,
      client_id: null,
      address: null,
      status,
      start_on: startOn,
      end_on: null,
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
  await addSite(s, 'A da iniziare inizio passato', 'planned', '2025-03-03')
  await addSite(s, 'B da iniziare inizio oggi', 'planned', today)
  await addSite(s, 'C da iniziare inizio futuro', 'planned', '2099-01-04')
  await addSite(s, 'D da iniziare senza inizio', 'planned', null)
  await addSite(s, 'E in corso inizio passato', 'active', '2025-03-03')
  await addSite(s, 'F sospeso inizio passato', 'suspended', '2025-03-03')
  await addSite(s, 'G chiuso inizio passato', 'completed', '2025-03-03')
}

describe('planned sites whose start has come', () => {
  it('filters planned sites starting today or earlier, and all the others', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[start_due]=true')).toEqual([
      'A da iniziare inizio passato',
      'B da iniziare inizio oggi',
    ])
    expect(await names(s, 'filter[start_due]=false')).toEqual([
      'C da iniziare inizio futuro',
      'D da iniziare senza inizio',
      'E in corso inizio passato',
      'F sospeso inizio passato',
      'G chiuso inizio passato',
    ])
    expect(await names(s, 'filter[start_due]=true&search=oggi')).toEqual([
      'B da iniziare inizio oggi',
    ])
    expect(await names(s, 'filter[start_due]=false&filter[status]=planned')).toEqual([
      'C da iniziare inizio futuro',
      'D da iniziare senza inizio',
    ])
    expect(await names(s, '')).toHaveLength(7)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call('GET', `${s.base}/export?sort=name&filter[start_due]=true`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes('inizio')))).toEqual([
      'A da iniziare inizio passato',
      'B da iniziare inizio oggi',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[start_due]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[start_due]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui da avviare', 'planned', '2025-01-07')
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: { start_due: number } }>().sites.start_due).toBe(2)
    expect(await names(other, 'filter[start_due]=true')).toEqual(['Altrui da avviare'])
    const fromOther = await other.browser.call(
      'GET',
      `/api/companies/${other.company.slug}/dashboard`,
    )
    expect(fromOther.json<{ sites: { start_due: number } }>().sites.start_due).toBe(1)
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[start_due]=true`)
      expect(res.statusCode).toBe(403)
    }
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})
