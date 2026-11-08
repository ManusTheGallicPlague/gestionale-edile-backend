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

async function employee(companyId: string, active = true) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, active, hourly_cost_cents)
     values ($1, 'Mario', 'Verdi', $2, 456789) returning id`,
    [companyId, active],
  )
  return rows[0]?.id ?? ''
}

async function scene(permissions: Permission[] = ['sites.view', 'employees.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const employeeId = await employee(company.id)
  return {
    browser,
    company,
    employeeId,
    url: `/api/companies/${company.slug}/employees/${employeeId}/sites`,
  }
}

async function site(companyId: string, name: string, status: string, team: string[] = []) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, status, code)
     values ($1, $2, $3, case when $2 = 'Villetta' then 'C-01' end) returning id`,
    [companyId, name, status],
  )
  const id = rows[0]?.id ?? ''
  for (const e of team) {
    await ctx.owner.query(
      'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
      [companyId, id, e],
    )
  }
  return id
}

describe('sites of an employee', () => {
  it('lists the sites whose team has the employee, in progress first', async () => {
    const { browser, company, employeeId: e, url } = await scene()
    const other = await employee(company.id)
    const closed = await site(company.id, 'Arena', 'completed', [e])
    const villetta = await site(company.id, 'Villetta', 'active', [e, other])
    const planned = await site(company.id, 'Box', 'planned', [e])
    const condominio = await site(company.id, 'Condominio', 'active', [e])
    const suspended = await site(company.id, 'Scuola', 'suspended', [e])
    await site(company.id, 'Altra squadra', 'active', [other])
    await site(company.id, 'Senza squadra', 'active')

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { site_id: condominio, code: null, name: 'Condominio', status: 'active' },
        { site_id: villetta, code: 'C-01', name: 'Villetta', status: 'active' },
        { site_id: planned, code: null, name: 'Box', status: 'planned' },
        { site_id: suspended, code: null, name: 'Scuola', status: 'suspended' },
        { site_id: closed, code: null, name: 'Arena', status: 'completed' },
      ],
    })
    expect(res.body).not.toContain('4567')
  })

  it('works for an inactive employee and for one without sites', async () => {
    const { browser, company } = await scene()
    const former = await employee(company.id, false)
    const s = await site(company.id, 'Villetta', 'completed', [former])
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/employees/${former}/sites`,
    )
    expect(res.json()).toEqual({
      data: [{ site_id: s, code: 'C-01', name: 'Villetta', status: 'completed' }],
    })
    const none = await employee(company.id)
    const empty = await browser.call(
      'GET',
      `/api/companies/${company.slug}/employees/${none}/sites`,
    )
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [] })
  })

  it('needs employees.view (404) and sites.view (403)', async () => {
    const office = await scene(['employees.view'])
    expect((await office.browser.call('GET', office.url)).statusCode).toBe(403)
    const chief = await scene(['sites.view'])
    expect((await chief.browser.call('GET', chief.url)).statusCode).toBe(404)
    const mine = await scene()
    expect(
      (await mine.browser.call('GET', mine.url.replace(mine.employeeId, 'nope'))).statusCode,
    ).toBe(404)
    expect(
      (
        await mine.browser.call(
          'GET',
          mine.url.replace(mine.employeeId, '00000000-0000-4000-8000-000000000000'),
        )
      ).statusCode,
    ).toBe(404)
    expect((await new Browser(ctx.app).call('GET', mine.url)).statusCode).toBe(401)
  })

  it('does not show another company’s employee or sites', async () => {
    const mine = await scene()
    const theirs = await scene()
    const s = await site(theirs.company.id, 'Loro', 'active', [theirs.employeeId])
    const other = `/api/companies/${mine.company.slug}/employees/${theirs.employeeId}/sites`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    expect((await theirs.browser.call('GET', theirs.url)).json()).toEqual({
      data: [{ site_id: s, code: null, name: 'Loro', status: 'active' }],
    })
    expect((await mine.browser.call('GET', mine.url)).json()).toEqual({ data: [] })
  })
})
