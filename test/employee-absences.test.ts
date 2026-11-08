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

const ALL: Permission[] = ['employees.view', 'employees.update', 'employees.delete']

function body(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'vacation',
    starts_on: '2026-08-10',
    ends_on: '2026-08-21',
    hours: null,
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
    [company.id],
  )
  const employee = rows[0]?.id ?? ''
  const employees = `/api/companies/${company.slug}/employees`
  return { browser, company, employee, employees, base: `${employees}/${employee}/absences` }
}

type Absence = {
  id: string
  kind: string
  starts_on: string
  ends_on: string
  hours: string | null
  days: number
}

describe('employee absences', () => {
  it('records a period and a few hours of leave, newest first, with the days', async () => {
    const { browser, base, employee } = await scene()
    const holiday = await browser.call('POST', base, { body: body() })
    expect(holiday.statusCode).toBe(201)
    expect(holiday.headers.etag).toBe('"1"')
    expect(holiday.json()).toMatchObject({
      employee_id: employee,
      kind: 'vacation',
      starts_on: '2026-08-10',
      ends_on: '2026-08-21',
      hours: null,
      days: 12,
    })
    const leave = await browser.call('POST', base, {
      body: body({ kind: 'leave', starts_on: '2026-09-03', ends_on: '2026-09-03', hours: '2.5' }),
    })
    expect(leave.statusCode).toBe(201)
    expect(leave.json()).toMatchObject({ hours: '2.50', days: 1 })

    const list = await browser.call('GET', base)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Absence[] }>().data.map((a) => a.starts_on)).toEqual([
      '2026-09-03',
      '2026-08-10',
    ])
  })

  it('filters on the absences that touch the period, ends included', async () => {
    const { browser, base } = await scene()
    await browser.call('POST', base, { body: body() })
    await browser.call('POST', base, {
      body: body({ kind: 'sick_leave', starts_on: '2026-08-31', ends_on: '2026-09-02' }),
    })
    const of = async (query: string) =>
      (await browser.call('GET', `${base}?${query}`))
        .json<{ data: Absence[] }>()
        .data.map((a) => a.kind)
    expect(await of('filter[from]=2026-09-01&filter[to]=2026-09-30')).toEqual(['sick_leave'])
    expect(await of('filter[from]=2026-08-21&filter[to]=2026-08-31')).toEqual([
      'sick_leave',
      'vacation',
    ])
    expect(await of('filter[to]=2026-08-09')).toEqual([])
    expect(await of('filter[from]=2026-08-22&filter[to]=2026-08-30')).toEqual([])
    const bad = await browser.call('GET', `${base}?filter[from]=2026-09-30&filter[to]=2026-09-01`)
    expect(bad.statusCode).toBe(422)
    const wrong = await browser.call('GET', `${base}?filter[from]=31/08/2026`)
    expect(wrong.statusCode).toBe(422)
  })

  it.each([
    ['an unknown kind', { kind: 'sciopero' }, 'kind'],
    ['a missing start', { starts_on: null }, 'starts_on'],
    ['an impossible date', { ends_on: '2026-02-30' }, 'ends_on'],
    ['an end before the start', { ends_on: '2026-08-09' }, 'ends_on'],
    ['hours over more days', { hours: '4' }, 'hours'],
    ['too many hours', { ends_on: '2026-08-10', hours: '25' }, 'hours'],
    ['hours with a comma', { ends_on: '2026-08-10', hours: '2,5' }, 'hours'],
    ['other without notes', { kind: 'other' }, 'notes'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: body(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('refuses overlapping absences, but not when an absence is moved within itself', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: body() })
    const touching = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-21', ends_on: '2026-08-25' }),
    })
    expect(touching.statusCode).toBe(422)
    expect(touching.json<{ errors: object }>().errors).toHaveProperty('starts_on')
    const around = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-01', ends_on: '2026-08-31' }),
    })
    expect(around.statusCode).toBe(422)
    const next = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-22', ends_on: '2026-08-22' }),
    })
    expect(next.statusCode).toBe(201)

    const url = `${base}/${created.json<Absence>().id}`
    const shorter = await browser.call('PUT', url, {
      body: body({ ends_on: '2026-08-14' }),
      headers: { 'if-match': '"1"' },
    })
    expect(shorter.statusCode).toBe(200)
    const onTheNext = await browser.call('PUT', url, {
      body: body({ ends_on: '2026-08-22' }),
      headers: { 'if-match': '"2"' },
    })
    expect(onTheNext.statusCode).toBe(422)
  })

  it('updates with If-Match and deletes; stale is 412, missing is 428', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: body() })
    const url = `${base}/${created.json<Absence>().id}`
    const changed = body({ kind: 'injury', notes: 'Infortunio in cantiere' })
    const updated = await browser.call('PUT', url, {
      body: changed,
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ kind: 'injury', notes: 'Infortunio in cantiere' })
    const stale = await browser.call('PUT', url, { body: changed, headers: { 'if-match': '"1"' } })
    expect(stale.statusCode).toBe(412)
    expect((await browser.call('PUT', url, { body: changed })).statusCode).toBe(428)
    expect((await browser.call('DELETE', url)).statusCode).toBe(428)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })).statusCode).toBe(
      412,
    )
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      204,
    )
    expect((await browser.call('GET', base)).json<{ data: Absence[] }>().data).toEqual([])
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      404,
    )
  })

  it('the absences go with the employee when it is deleted', async () => {
    const { browser, base, employees, employee } = await scene()
    await browser.call('POST', base, { body: body() })
    const del = await browser.call('DELETE', `${employees}/${employee}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(del.statusCode).toBe(204)
    const { rowCount } = await ctx.owner.query(
      'select 1 from public.employee_absences where employee_id = $1',
      [employee],
    )
    expect(rowCount).toBe(0)
  })

  it('reading needs employees.view (404), writing employees.update (403)', async () => {
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)
    const reader = await scene(['employees.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    expect((await reader.browser.call('POST', reader.base, { body: body() })).statusCode).toBe(403)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', reader.base)).statusCode).toBe(401)
  })

  it('needs the CSRF token to write', async () => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: body(), csrf: false })
    expect(res.statusCode).toBe(403)
  })

  it('absences of another company, or of another employee, are out of reach', async () => {
    const mine = await scene()
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: body() })
    const id = created.json<Absence>().id
    const headers = { 'if-match': '"1"' }

    const viaMyCompany = `/api/companies/${mine.company.slug}/employees/${theirs.employee}/absences`
    expect((await mine.browser.call('GET', viaMyCompany)).statusCode).toBe(404)
    expect((await mine.browser.call('POST', viaMyCompany, { body: body() })).statusCode).toBe(404)
    const underMine = `${mine.base}/${id}`
    expect((await mine.browser.call('PUT', underMine, { body: body(), headers })).statusCode).toBe(
      404,
    )
    expect((await mine.browser.call('DELETE', underMine, { headers })).statusCode).toBe(404)
    // Their absence does not block the same days for my employee.
    expect((await mine.browser.call('POST', mine.base, { body: body() })).statusCode).toBe(201)
    const still = await theirs.browser.call('GET', theirs.base)
    expect(still.json<{ data: Absence[] }>().data.map((a) => a.id)).toEqual([id])
  })
})

describe('absences of the whole company', () => {
  type Row = Absence & { employee: { id: string; last_name: string; active: boolean } }

  async function company(permissions: Permission[] = ALL) {
    const s = await scene(permissions)
    const { rows } = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name, active) values ($1, 'Anna', 'Bianchi', false) returning id",
      [s.company.id],
    )
    const other = rows[0]?.id ?? ''
    const add = (employee: string, kind: string, starts: string, ends: string) =>
      ctx.owner.query(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, notes)
         values ($1, $2, $3, $4, $5, 'x')`,
        [s.company.id, employee, kind, starts, ends],
      )
    await add(s.employee, 'vacation', '2026-08-10', '2026-08-21')
    await add(s.employee, 'sick_leave', '2026-09-01', '2026-09-02')
    await add(other, 'vacation', '2026-08-17', '2026-08-28')
    return { ...s, other, list: `/api/companies/${s.company.slug}/absences` }
  }

  it('lists every absence with its employee, newest first, filtered and paged', async () => {
    const { browser, list, employee, other } = await company()
    const all = await browser.call('GET', list)
    expect(all.statusCode).toBe(200)
    const body = all.json<{ data: Row[]; meta: object }>()
    expect(body.data.map((r) => [r.kind, r.employee.last_name, r.employee.active])).toEqual([
      ['sick_leave', 'Operaio', true],
      ['vacation', 'Bianchi', false],
      ['vacation', 'Operaio', true],
    ])
    expect(body.meta).toEqual({ total: 3, page: 1, per_page: 25 })

    const of = async (query: string) =>
      (await browser.call('GET', `${list}?${query}`)).json<{
        data: Row[]
        meta: { total: number }
      }>()
    // Who is away on one day.
    const day = await of('filter[from]=2026-08-21&filter[to]=2026-08-21')
    expect(day.data.map((r) => r.employee.id)).toEqual([other, employee])
    expect((await of('filter[from]=2026-08-22&filter[to]=2026-08-31')).meta.total).toBe(1)
    expect((await of('filter[kind]=vacation')).meta.total).toBe(2)
    expect((await of(`filter[employee]=${other}`)).data.map((r) => r.kind)).toEqual(['vacation'])
    const paged = await of('per_page=2&page=2')
    expect(paged.data).toHaveLength(1)
    expect(paged.meta).toEqual({ total: 3, page: 2, per_page: 2 })
  })

  it.each([
    ['filter[kind]=sciopero', 'filter[kind]'],
    ['filter[employee]=abc', 'filter[employee]'],
    ['filter[from]=2026-13-01', 'filter[from]'],
    ['filter[from]=2026-09-02&filter[to]=2026-09-01', 'filter[to]'],
    ['per_page=101', 'per_page'],
  ])('refuses %s', async (query, field) => {
    const { browser, list } = await company()
    const res = await browser.call('GET', `${list}?${query}`)
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('shows only the absences of this company', async () => {
    const mine = await company()
    const theirs = await company()
    const res = await mine.browser.call('GET', mine.list)
    const ids = res.json<{ data: Row[] }>().data.map((r) => r.employee.id)
    expect(new Set(ids)).toEqual(new Set([mine.employee, mine.other]))
    const filtered = await mine.browser.call('GET', `${mine.list}?filter[employee]=${theirs.other}`)
    expect(filtered.json<{ data: Row[] }>().data).toEqual([])
  })

  it('needs employees.view (403) and a session (401)', async () => {
    const blind = await company(['clients.view'])
    expect((await blind.browser.call('GET', blind.list)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', blind.list)).statusCode).toBe(401)
  })
})
