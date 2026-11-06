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

const ALL: Permission[] = ['sites.view', 'sites.update', 'sites.delete', 'employees.delete']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, job_title, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 'Muratore', 2800), ($1, 'Anna', 'Bassi', null, 3000)
     returning id`,
    [company.id],
  )
  const siteId = site.rows[0]?.id ?? ''
  return {
    browser,
    company,
    siteId,
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    url: `/api/companies/${company.slug}/sites/${siteId}/team`,
  }
}

type Team = { data: { employee_id: string; last_name: string }[] }

describe('site team', () => {
  it('replaces the team and lists it by name, without costs', async () => {
    const { browser, url, verdi, bassi } = await scene()
    expect((await browser.call('GET', url)).json<Team>().data).toEqual([])
    const res = await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi, verdi] } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Team>().data.map((m) => m.last_name)).toEqual(['Bassi', 'Verdi'])
    expect(JSON.stringify(res.json())).not.toContain('cost')
    const after = await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(after.json<Team>().data.map((m) => m.employee_id)).toEqual([verdi])
    expect((await browser.call('GET', url)).json<Team>().data).toHaveLength(1)
  })

  it.each([
    ['no list', {}],
    ['a list of numbers', { employee_ids: [1] }],
    ['too many', { employee_ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }],
    ['an unknown employee', { employee_ids: [crypto.randomUUID()] }],
  ])('refuses %s', async (_label, body) => {
    const { browser, url } = await scene()
    const res = await browser.call('PUT', url, { body })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { employee_ids: [expect.any(String)] } })
  })

  it('an employee of another company cannot join; another company’s site is not found', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('PUT', mine.url, {
      body: { employee_ids: [theirs.verdi] },
    })
    expect(res.statusCode).toBe(422)
    const other = `/api/companies/${mine.company.slug}/sites/${theirs.siteId}/team`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('PUT', other, { body: { employee_ids: [mine.verdi] } })).statusCode,
    ).toBe(404)
    expect((await theirs.browser.call('GET', theirs.url)).json<Team>().data).toEqual([])
  })

  it('an employee in a team cannot be deleted; deleting the site frees them', async () => {
    const { browser, company, url, verdi, siteId } = await scene()
    await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    const employee = `/api/companies/${company.slug}/employees/${verdi}`
    const refused = await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'has_documents' })
    const site = `/api/companies/${company.slug}/sites/${siteId}`
    expect(
      (await browser.call('DELETE', site, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
    expect(
      (await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
  })

  it('reading needs sites.view, changing sites.update', async () => {
    const reader = await scene(['sites.view'])
    expect((await reader.browser.call('GET', reader.url)).statusCode).toBe(200)
    expect(
      (await reader.browser.call('PUT', reader.url, { body: { employee_ids: [] } })).statusCode,
    ).toBe(403)
    const blind = await scene(['employees.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(404)
  })
})
