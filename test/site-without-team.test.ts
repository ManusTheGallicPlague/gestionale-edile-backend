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
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, active)
     values ($1, 'Luca', 'Verdi', true), ($1, 'Anna', 'Bassi', false)
     returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    base: `/api/companies/${company.slug}/sites`,
    inService: employees.rows[0]?.id ?? '',
    former: employees.rows[1]?.id ?? '',
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function addSite(s: Scene, name: string, status: string, team: string[] = []) {
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
  if (team.length > 0) {
    const id = res.json<{ id: string }>().id
    const put = await s.browser.call('PUT', `${s.base}/${id}/team`, {
      body: { employee_ids: team },
    })
    expect(put.statusCode).toBe(200)
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
  await addSite(s, 'A da iniziare senza squadra', 'planned')
  await addSite(s, 'B in corso senza squadra', 'active')
  await addSite(s, 'C in corso con un ex dipendente in squadra', 'active', [s.former])
  await addSite(s, 'D in corso con la squadra', 'active', [s.inService, s.former])
  await addSite(s, 'E da iniziare con la squadra', 'planned', [s.inService])
  await addSite(s, 'F sospeso senza squadra', 'suspended')
  await addSite(s, 'G chiuso senza squadra', 'completed')
}

describe('sites without a team', () => {
  it('filters planned and active sites without an employee in service, and all the others', async () => {
    const s = await scene()
    await fill(s)
    expect(await names(s, 'filter[without_team]=true')).toEqual([
      'A da iniziare senza squadra',
      'B in corso senza squadra',
      'C in corso con un ex dipendente in squadra',
    ])
    expect(await names(s, 'filter[without_team]=false')).toEqual([
      'D in corso con la squadra',
      'E da iniziare con la squadra',
      'F sospeso senza squadra',
      'G chiuso senza squadra',
    ])
    expect(await names(s, 'filter[without_team]=true&filter[status]=active')).toEqual([
      'B in corso senza squadra',
      'C in corso con un ex dipendente in squadra',
    ])
    expect(await names(s, 'filter[without_team]=true&search=iniziare')).toEqual([
      'A da iniziare senza squadra',
    ])
    expect(await names(s, '')).toHaveLength(7)
  })

  it('applies the same filter to the CSV', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call('GET', `${s.base}/export?sort=name&filter[without_team]=true`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(';').find((c) => c.includes('squadra')))).toEqual([
      'A da iniziare senza squadra',
      'B in corso senza squadra',
      'C in corso con un ex dipendente in squadra',
    ])
  })

  it('rejects a value other than true or false', async () => {
    const s = await scene()
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[without_team]=si`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors).toEqual({
        'filter[without_team]': ['Indica true o false.'],
      })
    }
  })

  it('counts them in the dashboard, without the sites and teams of another company', async () => {
    const s = await scene()
    await fill(s)
    const other = await scene()
    await addSite(other, 'Altrui senza squadra', 'active')
    await addSite(other, 'Altrui con la squadra', 'active', [other.inService])
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ sites: { without_team: number } }>().sites.without_team).toBe(3)
    expect(await names(other, 'filter[without_team]=true')).toEqual(['Altrui senza squadra'])
    const fromOther = await other.browser.call(
      'GET',
      `/api/companies/${other.company.slug}/dashboard`,
    )
    expect(fromOther.json<{ sites: { without_team: number } }>().sites.without_team).toBe(1)
  })

  it('needs sites.view, also in the dashboard', async () => {
    const s = await scene([])
    for (const url of [s.base, `${s.base}/export`]) {
      const res = await s.browser.call('GET', `${url}?filter[without_team]=true`)
      expect(res.statusCode).toBe(403)
    }
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json<{ sites: unknown }>().sites).toBeNull()
  })
})
