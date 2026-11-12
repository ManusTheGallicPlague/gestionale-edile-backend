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

const ALL: Permission[] = ['sites.view', 'sites.create', 'sites.update', 'reports.view']

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

/** A site with daily reports on the given days (offsets from today). */
async function addSite(s: Scene, name: string, status: string, reports: number[] = []) {
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
    },
  })
  expect(res.statusCode).toBe(201)
  const id = res.json<{ id: string }>().id
  for (const offset of reports) {
    await ctx.owner.query(
      `insert into public.daily_reports (company_id, site_id, report_date) values ($1, $2, $3)`,
      [s.company.id, id, day(offset)],
    )
  }
}

async function names(s: Scene, query: string) {
  const res = await s.browser.call('GET', `${s.base}?sort=name&${query}`)
  expect(res.statusCode).toBe(200)
  const body = res.json<{ data: { name: string }[]; meta: { total: number } }>()
  expect(body.meta.total).toBe(body.data.length)
  return body.data.map((x) => x.name)
}

async function fill(s: Scene) {
  await addSite(s, 'A in corso rapportino oggi', 'active', [0])
  await addSite(s, 'B in corso rapportino 6 giorni fa', 'active', [-6])
  await addSite(s, 'C in corso rapportino 7 giorni fa', 'active', [-7, -20])
  await addSite(s, 'D in corso senza rapportini', 'active')
  await addSite(s, 'E in corso rapportino domani', 'active', [1])
  await addSite(s, 'F sospeso senza rapportini', 'suspended')
  await addSite(s, 'G da iniziare senza rapportini', 'planned')
  await addSite(s, 'H chiuso senza rapportini', 'completed')
}

describe('active sites without recent daily reports', () => {
  it('filters active sites without a report in the last 7 days, and all the others', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[without_recent_reports]=true')).toEqual([
      'C in corso rapportino 7 giorni fa',
      'D in corso senza rapportini',
      'E in corso rapportino domani',
    ])
    expect(await names(s, 'filter[without_recent_reports]=false')).toEqual([
      'A in corso rapportino oggi',
      'B in corso rapportino 6 giorni fa',
      'F sospeso senza rapportini',
      'G da iniziare senza rapportini',
      'H chiuso senza rapportini',
    ])
    expect(await names(s, 'filter[without_recent_reports]=true&search=senza')).toEqual([
      'D in corso senza rapportini',
    ])
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?sort=name&filter[without_recent_reports]=true`,
    )
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes(' in corso ')))).toEqual([
      'C in corso rapportino 7 giorni fa',
      'D in corso senza rapportini',
      'E in corso rapportino domani',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[without_recent_reports]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[without_recent_reports]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites or reports of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui in corso senza', 'active')
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    const reports = res.json<{ reports: { missing_today: number; missing_week: number } }>().reports
    expect(reports).toEqual({ to_approve: 0, drafts: 3, missing_today: 4, missing_week: 3 })
    expect(await names(other, 'filter[without_recent_reports]=true')).toEqual([
      'Altrui in corso senza',
    ])
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene(['reports.view'])
    const res = await s.browser.call('GET', `${s.base}?filter[without_recent_reports]=true`)
    expect(res.statusCode).toBe(403)
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ reports: unknown }>().reports).toEqual({
      to_approve: 0,
      drafts: 0,
      missing_today: null,
      missing_week: null,
    })
  })
})
