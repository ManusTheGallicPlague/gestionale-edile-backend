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

async function addSite(s: Scene, name: string, status: string, coordinator: string | null) {
  const res = await s.browser.call('POST', s.base, {
    body: {
      code: null,
      name,
      client_id: null,
      address: null,
      status,
      start_on: null,
      end_on: null,
      budget: null,
      notes: null,
      safety_coordinator: coordinator,
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
  await addSite(s, 'A da iniziare senza', 'planned', null)
  await addSite(s, 'B in corso senza', 'active', null)
  await addSite(s, 'C sospeso senza', 'suspended', null)
  await addSite(s, 'D chiuso senza', 'completed', null)
  await addSite(s, 'E in corso con', 'active', 'Ing. Coordinatore Esempio')
  await addSite(s, 'F chiuso con', 'completed', 'Geom. Sicurezza Esempio')
}

describe('sites without the safety coordinator', () => {
  it('filters open sites without the coordinator, and sites with it in any status', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[safety_coordinator_missing]=true')).toEqual([
      'A da iniziare senza',
      'B in corso senza',
      'C sospeso senza',
    ])
    expect(
      await names(s, 'filter[safety_coordinator_missing]=true&filter[permit_missing]=false'),
    ).toEqual([])
    expect(await names(s, 'filter[safety_coordinator_missing]=false')).toEqual([
      'E in corso con',
      'F chiuso con',
    ])
    expect(await names(s, 'filter[safety_coordinator_missing]=true&filter[status]=active')).toEqual(
      ['B in corso senza'],
    )
    expect(await names(s, '')).toHaveLength(6)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=name&filter[safety_coordinator_missing]=true`,
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
      const res = await s.browser.call('GET', `${url}?filter[safety_coordinator_missing]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[safety_coordinator_missing]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui senza', 'active', null)
    const dashboard = `/api/companies/${s.company.slug}/dashboard`
    const res = await s.browser.call('GET', dashboard)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: unknown }>().sites).toEqual({
      planned: 1,
      active: 2,
      suspended: 1,
      completed: 2,
      without_prior_notice: 4,
      past_end: 0,
      ending_soon: 0,
      start_due: 0,
      without_team: 3,
      without_permit: 4,
      without_safety_coordinator: 3,
    })
    const fromOther = await other.browser.call(
      'GET',
      `${other.base}?filter[safety_coordinator_missing]=true`,
    )
    expect(fromOther.json<{ data: { name: string }[] }>().data.map((x) => x.name)).toEqual([
      'Altrui senza',
    ])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[safety_coordinator_missing]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})

describe('the safety coordinator filter and the site form', () => {
  it('treats an empty coordinator as missing and follows updates', async () => {
    const s = await scene()
    await addSite(s, 'G vuoto', 'active', '')
    expect(await names(s, 'filter[safety_coordinator_missing]=true')).toEqual(['G vuoto'])
    const list = await s.browser.call('GET', s.base)
    const site = list.json<{ data: { id: string; name: string }[] }>().data[0]!
    const updated = await s.browser.call('PUT', `${s.base}/${site.id}`, {
      headers: { 'if-match': '"1"' },
      body: {
        code: null,
        name: site.name,
        client_id: null,
        address: null,
        status: 'active',
        start_on: null,
        end_on: null,
        budget: null,
        notes: null,
        safety_coordinator: 'Arch. Coordinatrice Esempio',
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(await names(s, 'filter[safety_coordinator_missing]=true')).toEqual([])
    expect(await names(s, 'filter[safety_coordinator_missing]=false')).toEqual(['G vuoto'])
  })
})
