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

async function newSite(companyId: string) {
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [companyId],
  )
  return site.rows[0]?.id ?? ''
}

async function scene(permissions: Permission[] = ['sites.view', 'sites.update', 'sites.delete']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const siteId = await newSite(company.id)
  return {
    browser,
    company,
    siteId,
    email: user.email,
    url: `/api/companies/${company.slug}/sites/${siteId}/activities`,
  }
}

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Scavi',
  start_on: '2026-11-09',
  end_on: '2026-11-13',
  progress: 0,
  depends_on: [],
  notes: null,
  ...overrides,
})

interface Activity {
  id: string
  name: string
  progress: number
  depends_on: string[]
}

describe('site activities', () => {
  it('creates, lists in order, updates with dependencies and deletes', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.url, { body: body() })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const scavi = created.json<Activity>()
    expect(scavi).toMatchObject({ name: 'Scavi', site_id: s.siteId, depends_on: [] })
    const fondazioni = (
      await s.browser.call('POST', s.url, {
        body: body({
          name: 'Fondazioni',
          start_on: '2026-11-16',
          end_on: '2026-11-27',
          depends_on: [scavi.id, scavi.id.toUpperCase()],
        }),
      })
    ).json<Activity>()
    expect(fondazioni.depends_on).toEqual([scavi.id])
    await s.browser.call('POST', s.url, {
      body: body({ name: 'Allestimento', start_on: '2026-11-02', end_on: '2026-11-02' }),
    })

    const list = await s.browser.call('GET', s.url)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Activity[] }>().data.map((a) => a.name)).toEqual([
      'Allestimento',
      'Scavi',
      'Fondazioni',
    ])

    const scaviUrl = `${s.url}/${scavi.id}`
    expect((await s.browser.call('PUT', scaviUrl, { body: body() })).statusCode).toBe(428)
    const cycle = await s.browser.call('PUT', scaviUrl, {
      body: body({ depends_on: [fondazioni.id] }),
      headers: { 'if-match': '"1"' },
    })
    expect(cycle.statusCode).toBe(422)
    expect(cycle.json()).toMatchObject({ errors: { depends_on: [expect.any(String)] } })
    const self = await s.browser.call('PUT', scaviUrl, {
      body: body({ depends_on: [scavi.id] }),
      headers: { 'if-match': '"1"' },
    })
    expect(self.statusCode).toBe(422)
    const updated = await s.browser.call('PUT', scaviUrl, {
      body: body({ progress: 60, notes: 'Terreno roccioso' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json<Activity>().progress).toBe(60)
    expect(
      (
        await s.browser.call('PUT', scaviUrl, {
          body: body(),
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(412)

    expect(
      (await s.browser.call('DELETE', scaviUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(204)
    const after = (await s.browser.call('GET', s.url)).json<{ data: Activity[] }>().data
    expect(after.find((a) => a.id === fondazioni.id)?.depends_on).toEqual([])
    expect(
      (await s.browser.call('DELETE', scaviUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(404)
  })

  it.each([
    ['no name', { name: '' }],
    ['a bad date', { start_on: '2026-02-30' }],
    ['a missing date', { end_on: null }],
    ['the end before the start', { end_on: '2026-11-01' }],
    ['progress over 100', { progress: 101 }],
    ['fractional progress', { progress: 1.5 }],
    ['progress as text', { progress: '10' }],
    ['dependencies not a list', { depends_on: 'x' }],
    ['an unknown dependency', { depends_on: [crypto.randomUUID()] }],
    [
      'too many dependencies',
      { depends_on: Array.from({ length: 51 }, () => crypto.randomUUID()) },
    ],
  ])('refuses %s with 422', async (_, overrides) => {
    const s = await scene()
    const res = await s.browser.call('POST', s.url, { body: body(overrides) })
    expect(res.statusCode).toBe(422)
    expect((await s.browser.call('GET', s.url)).json<{ data: unknown[] }>().data).toEqual([])
  })

  it('refuses a cycle closed by two edits at the same time', async () => {
    const s = await scene()
    const a = (await s.browser.call('POST', s.url, { body: body({ name: 'A' }) })).json<Activity>()
    const b = (await s.browser.call('POST', s.url, { body: body({ name: 'B' }) })).json<Activity>()
    // A second session of the same user: requests of one session can wait for each other.
    const second = new Browser(ctx.app)
    await second.signIn(s.email)
    const results = await Promise.all([
      s.browser.call('PUT', `${s.url}/${a.id}`, {
        body: body({ name: 'A', depends_on: [b.id] }),
        headers: { 'if-match': '"1"' },
      }),
      second.call('PUT', `${s.url}/${b.id}`, {
        body: body({ name: 'B', depends_on: [a.id] }),
        headers: { 'if-match': '"1"' },
      }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422])
  })

  it('does not take dependencies from another site', async () => {
    const s = await scene()
    const otherSite = await newSite(s.company.id)
    const other = (
      await s.browser.call(
        'POST',
        `/api/companies/${s.company.slug}/sites/${otherSite}/activities`,
        {
          body: body(),
        },
      )
    ).json<Activity>()
    const res = await s.browser.call('POST', s.url, { body: body({ depends_on: [other.id] }) })
    expect(res.statusCode).toBe(422)
    const moved = await s.browser.call('DELETE', `${s.url}/${other.id}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(moved.statusCode).toBe(404)
  })

  it('goes away with the site', async () => {
    const s = await scene()
    await s.browser.call('POST', s.url, { body: body() })
    const del = await s.browser.call(
      'DELETE',
      `/api/companies/${s.company.slug}/sites/${s.siteId}`,
      {
        headers: { 'if-match': '"1"' },
      },
    )
    expect(del.statusCode).toBe(204)
    const { rowCount } = await ctx.owner.query(
      'select 1 from public.site_activities where site_id = $1',
      [s.siteId],
    )
    expect(rowCount).toBe(0)
  })

  it('checks the permissions and keeps other companies out', async () => {
    const owner = await scene()
    const activity = (
      await owner.browser.call('POST', owner.url, { body: body() })
    ).json<Activity>()
    const activityUrl = `${owner.url}/${activity.id}`

    const viewer = await fx.user()
    await fx.member(
      viewer.id,
      owner.company.id,
      await fx.role(owner.company.id, 'Vista', ['sites.view']),
    )
    const browser = new Browser(ctx.app)
    await browser.signIn(viewer.email)
    expect((await browser.call('GET', owner.url)).statusCode).toBe(200)
    expect((await browser.call('POST', owner.url, { body: body() })).statusCode).toBe(403)
    expect(
      (await browser.call('PUT', activityUrl, { body: body(), headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (await browser.call('DELETE', activityUrl, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(403)

    const none = await fx.user()
    await fx.member(none.id, owner.company.id, await fx.role(owner.company.id, 'Nessuno', []))
    const blind = new Browser(ctx.app)
    await blind.signIn(none.email)
    expect((await blind.call('GET', owner.url)).statusCode).toBe(404)
    expect((await blind.call('POST', owner.url, { body: body() })).statusCode).toBe(404)

    const other = await scene()
    const theirs = `/api/companies/${other.company.slug}/sites/${owner.siteId}/activities`
    expect((await other.browser.call('GET', theirs)).statusCode).toBe(404)
    expect((await other.browser.call('POST', theirs, { body: body() })).statusCode).toBe(404)
    expect(
      (
        await other.browser.call('PUT', `${other.url}/${activity.id}`, {
          body: body(),
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (await other.browser.call('POST', other.url, { body: body({ depends_on: [activity.id] }) }))
        .statusCode,
    ).toBe(422)
    expect((await owner.browser.call('GET', owner.url)).json<{ data: Activity[] }>().data).toEqual([
      expect.objectContaining({ id: activity.id, progress: 0 }),
    ])
  })
})
