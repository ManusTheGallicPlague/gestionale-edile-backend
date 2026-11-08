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

const ALL: Permission[] = ['employees.view', 'employees.update']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
    [company.id],
  )
  const employee = rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/employees/${employee}/leave-carryovers`
  return { browser, company, employee, base }
}

type Carryover = { year: number; days: number; updated_at: string }

describe('vacation carried over from the year before', () => {
  it('sets, replaces and deletes the carry-over of a year, newest first', async () => {
    const { browser, base } = await scene()
    const empty = await browser.call('GET', base)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [] })

    const set = await browser.call('PUT', `${base}/2026`, { body: { days: 5 } })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ year: 2026, days: 5 })
    expect((await browser.call('PUT', `${base}/2027`, { body: { days: -2 } })).statusCode).toBe(200)
    // The value is absolute: a second PUT replaces it.
    const again = await browser.call('PUT', `${base}/2026`, { body: { days: 0 } })
    expect(again.json<Carryover>().days).toBe(0)
    const list = await browser.call('GET', base)
    expect(list.json<{ data: Carryover[] }>().data.map((c) => [c.year, c.days])).toEqual([
      [2027, -2],
      [2026, 0],
    ])

    expect((await browser.call('DELETE', `${base}/2027`)).statusCode).toBe(204)
    expect((await browser.call('DELETE', `${base}/2027`)).statusCode).toBe(404)
    const left = await browser.call('GET', base)
    expect(left.json<{ data: Carryover[] }>().data.map((c) => c.year)).toEqual([2026])
  })

  it('refuses wrong days without changing anything, and a year out of range', async () => {
    const { browser, base } = await scene()
    await browser.call('PUT', `${base}/2026`, { body: { days: 3 } })
    for (const body of [
      {},
      { days: 2.5 },
      { days: '3' },
      { days: null },
      { days: 367 },
      { days: -367 },
    ]) {
      const res = await browser.call('PUT', `${base}/2026`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['days'])
    }
    const extra = await browser.call('PUT', `${base}/2026`, { body: { days: 1, year: 2020 } })
    expect(extra.statusCode).toBe(422)
    expect(Object.keys(extra.json<{ errors: object }>().errors)).toEqual(['year'])
    expect((await browser.call('PUT', `${base}/2026`, { body: [1] })).statusCode).toBe(422)
    for (const year of ['2101', '1999', '26', 'anno']) {
      const res = await browser.request('PUT', `${base}/${year}`, { body: { days: 1 } })
      expect(res.statusCode).toBe(404)
      expect((await browser.request('DELETE', `${base}/${year}`)).statusCode).toBe(404)
    }
    const list = await browser.call('GET', base)
    expect(list.json<{ data: Carryover[] }>().data.map((c) => [c.year, c.days])).toEqual([
      [2026, 3],
    ])
  })

  it('goes away with the employee', async () => {
    const { browser, base, employee } = await scene()
    await browser.call('PUT', `${base}/2026`, { body: { days: 3 } })
    await ctx.owner.query('delete from public.employees where id = $1', [employee])
    const { rowCount } = await ctx.owner.query(
      'select 1 from public.employee_leave_carryovers where employee_id = $1',
      [employee],
    )
    expect(rowCount).toBe(0)
  })

  it('needs employees.view to read, employees.update to write, a session and CSRF', async () => {
    const reader = await scene(['employees.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    const put = await reader.browser.call('PUT', `${reader.base}/2026`, { body: { days: 1 } })
    expect(put.statusCode).toBe(403)
    expect((await reader.browser.call('DELETE', `${reader.base}/2026`)).statusCode).toBe(403)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', reader.base)).statusCode).toBe(401)
    expect(
      (await anonymous.call('PUT', `${reader.base}/2026`, { body: { days: 1 } })).statusCode,
    ).toBe(401)
    const writer = await scene()
    const noCsrf = await writer.browser.call('PUT', `${writer.base}/2026`, {
      body: { days: 1 },
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect((await writer.browser.call('GET', writer.base)).json()).toEqual({ data: [] })
  })

  it('carry-overs of another company are out of reach', async () => {
    const mine = await scene()
    const theirs = await scene()
    await theirs.browser.call('PUT', `${theirs.base}/2026`, { body: { days: 7 } })
    const viaMyCompany = `/api/companies/${mine.company.slug}/employees/${theirs.employee}/leave-carryovers`
    expect((await mine.browser.call('GET', viaMyCompany)).statusCode).toBe(404)
    const put = await mine.browser.call('PUT', `${viaMyCompany}/2026`, { body: { days: 1 } })
    expect(put.statusCode).toBe(404)
    expect((await mine.browser.call('DELETE', `${viaMyCompany}/2026`)).statusCode).toBe(404)
    // Their company in the path, with my session: not my company.
    expect((await mine.browser.call('GET', theirs.base)).statusCode).toBe(404)
    const still = await theirs.browser.call('GET', theirs.base)
    expect(still.json<{ data: Carryover[] }>().data.map((c) => c.days)).toEqual([7])
    // The same year for my employee is independent.
    await mine.browser.call('PUT', `${mine.base}/2026`, { body: { days: 2 } })
    const both = await theirs.browser.call('GET', theirs.base)
    expect(both.json<{ data: Carryover[] }>().data.map((c) => c.days)).toEqual([7])
  })
})
