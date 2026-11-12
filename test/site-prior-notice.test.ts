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

async function addSite(s: Scene, name: string, status: string, priorNoticeOn: string | null) {
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
      prior_notice_on: priorNoticeOn,
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
  await addSite(s, 'E in corso con', 'active', '2026-03-20')
  await addSite(s, 'F chiuso con', 'completed', '2025-01-10')
}

describe('sites without the prior notice', () => {
  it('filters open sites without the date, and sites with it in any status', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[prior_notice_missing]=true')).toEqual([
      'A da iniziare senza',
      'B in corso senza',
      'C sospeso senza',
    ])
    expect(await names(s, 'filter[prior_notice_missing]=false')).toEqual([
      'E in corso con',
      'F chiuso con',
    ])
    expect(await names(s, 'filter[prior_notice_missing]=true&filter[status]=active')).toEqual([
      'B in corso senza',
    ])
    expect(await names(s, '')).toHaveLength(6)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=name&filter[prior_notice_missing]=true`,
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
      const res = await s.browser.call('GET', `${url}?filter[prior_notice_missing]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[prior_notice_missing]': ['Indica true o false.'],
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
      without_prior_notice: 3,
      past_end: 0,
      ending_soon: 0,
      start_due: 0,
      without_team: 3,
      without_permit: 4,
      without_safety_coordinator: 4,
      without_works_director: 4,
    })
    const fromOther = await other.browser.call(
      'GET',
      `${other.base}?filter[prior_notice_missing]=true`,
    )
    expect(fromOther.json<{ data: { name: string }[] }>().data.map((x) => x.name)).toEqual([
      'Altrui senza',
    ])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    const res = await s.browser.call('GET', `${s.base}?filter[prior_notice_missing]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})
