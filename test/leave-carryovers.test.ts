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

type Carryover = {
  year: number
  days: number | null
  permit_hours: string | null
  updated_at: string
}

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
    for (const body of [{ days: 2.5 }, { days: '3' }, { days: 367 }, { days: -367 }]) {
      const res = await browser.call('PUT', `${base}/2026`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['days'])
    }
    for (const body of [
      { permit_hours: 4 },
      { permit_hours: '4,5' },
      { permit_hours: '4.125' },
      { permit_hours: '2000.01' },
      { permit_hours: '-2000.5' },
      { permit_hours: '' },
      { days: 1, permit_hours: '1e3' },
    ]) {
      const res = await browser.call('PUT', `${base}/2026`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['permit_hours'])
    }
    // Nothing at all, or nothing left: the carry-over goes with DELETE.
    for (const body of [{}, { days: null }, { days: null, permit_hours: null }]) {
      const res = await browser.call('PUT', `${base}/2026`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['_'])
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

  it('carries over leave hours next to the days, each kept when missing and removed with null', async () => {
    const { browser, base } = await scene()
    const hours = await browser.call('PUT', `${base}/2026`, { body: { permit_hours: '12.5' } })
    expect(hours.statusCode).toBe(200)
    expect(hours.json()).toMatchObject({ year: 2026, days: null, permit_hours: '12.50' })
    // The days alone keep the hours, the hours alone keep the days.
    const days = await browser.call('PUT', `${base}/2026`, { body: { days: 4 } })
    expect(days.json()).toMatchObject({ days: 4, permit_hours: '12.50' })
    const less = await browser.call('PUT', `${base}/2026`, { body: { permit_hours: '-3' } })
    expect(less.json()).toMatchObject({ days: 4, permit_hours: '-3.00' })
    const both = await browser.call('PUT', `${base}/2027`, {
      body: { days: -1, permit_hours: '2000' },
    })
    expect(both.json()).toMatchObject({ days: -1, permit_hours: '2000.00' })
    // Null removes one part; the other stays.
    const noHours = await browser.call('PUT', `${base}/2026`, { body: { permit_hours: null } })
    expect(noHours.json()).toMatchObject({ days: 4, permit_hours: null })
    const swap = await browser.call('PUT', `${base}/2026`, {
      body: { days: null, permit_hours: '0' },
    })
    expect(swap.json()).toMatchObject({ days: null, permit_hours: '0.00' })
    // Removing the last part is refused and changes nothing.
    const last = await browser.call('PUT', `${base}/2026`, { body: { permit_hours: null } })
    expect(last.statusCode).toBe(422)
    const list = await browser.call('GET', base)
    expect(
      list.json<{ data: Carryover[] }>().data.map((c) => [c.year, c.days, c.permit_hours]),
    ).toEqual([
      [2027, -1, '2000.00'],
      [2026, null, '0.00'],
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

describe('closing of the year', () => {
  type Closing = {
    year: number
    carried_into: number
    data: { employee: { id: string }; days: number | null; permit_hours: string | null }[]
  }

  async function staff(company: string) {
    const employee = async (
      last: string,
      active: boolean,
      leave: number | null,
      permit: number | null,
    ) => {
      const { rows } = await ctx.owner.query<{ id: string }>(
        `insert into public.employees
           (company_id, first_name, last_name, active, annual_leave_days, annual_permit_hours)
         values ($1, 'Nome', $2, $3, $4, $5) returning id`,
        [company, last, active, leave, permit],
      )
      return rows[0]?.id ?? ''
    }
    const mario = await employee('Rossi', true, 26, 88)
    const anna = await employee('Bianchi', true, null, 10)
    const piero = await employee('Neri', true, null, null)
    const luca = await employee('Verdi', false, 26, 88)
    const absence = (
      id: string,
      starts: string,
      ends: string,
      kind: string,
      hours: string | null,
    ) =>
      ctx.owner.query(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
         values ($1, $2, $3, $4, $5, $6, 'x')`,
        [company, id, kind, starts, ends, hours],
      )
    // 10 working days of vacation and 2.5 hours of leave in 2026; vacation of 2027 ignored.
    await absence(mario, '2026-08-10', '2026-08-21', 'vacation', null)
    await absence(mario, '2026-09-03', '2026-09-03', 'leave', '2.5')
    await absence(mario, '2027-08-02', '2027-08-06', 'vacation', null)
    // Luca is listed in the totals for his sick leave, but he is not active: not closed.
    await absence(luca, '2026-03-02', '2026-03-03', 'sick_leave', null)
    const carry = (id: string, year: number, days: number | null, hours: string | null) =>
      ctx.owner.query(
        `insert into public.employee_leave_carryovers (company_id, employee_id, year, days, permit_hours)
         values ($1, $2, $3, $4, $5)`,
        [company, id, year, days, hours],
      )
    await carry(mario, 2026, 2, null) // counts in the remaining vacation of 2026
    await carry(anna, 2027, 5, '1') // the days stay: no vacation allowance
    return { mario, anna, piero, luca }
  }

  const carryovers = async (company: string) =>
    (
      await ctx.owner.query<{
        employee_id: string
        year: number
        days: number | null
        hours: string | null
      }>(
        `select employee_id, year, days, permit_hours::text as hours
         from public.employee_leave_carryovers where company_id = $1
         order by employee_id, year`,
        [company],
      )
    ).rows

  it('carries the remaining vacation and leave hours of active employees into the year after', async () => {
    const { browser, company } = await scene()
    const s = await staff(company.id)
    const theirs = await scene()
    const other = await staff(theirs.company.id)
    const before = await carryovers(theirs.company.id)
    const url = `/api/companies/${company.slug}/absences/close-year`
    const res = await browser.call('POST', url, { body: { year: 2026 } })
    expect(res.statusCode).toBe(200)
    const body = res.json<Closing>()
    expect(body.year).toBe(2026)
    expect(body.carried_into).toBe(2027)
    // 26 + 2 - 10 days, 88 - 2.5 hours; Anna keeps her days and gets 10 hours.
    expect(body.data.map((d) => [d.employee.id, d.days, d.permit_hours])).toEqual([
      [s.anna, 5, '10.00'],
      [s.mario, 18, '85.50'],
    ])
    const rows = (await carryovers(company.id)).map((r) => [r.employee_id, r.year, r.days, r.hours])
    expect(rows).toEqual(
      expect.arrayContaining([
        [s.mario, 2026, 2, null],
        [s.mario, 2027, 18, '85.50'],
        [s.anna, 2027, 5, '10.00'],
      ]),
    )
    expect(rows).toHaveLength(3) // nothing for Piero (no allowance) or Luca (not active)
    // Again: the same values; the other company never touched.
    const again = await browser.call('POST', url, { body: { year: 2026 } })
    expect(again.json<Closing>().data).toEqual(body.data)
    expect(await carryovers(theirs.company.id)).toEqual(before)
    expect(other.mario).not.toBe(s.mario)
    // The remaining of 2027 now starts from the carry-over.
    const totals = await browser.call(
      'GET',
      `/api/companies/${company.slug}/absences/totals?year=2027`,
    )
    const mario = totals
      .json<{
        employees: {
          employee: { id: string }
          vacation_remaining: number
          permit_remaining: string
        }[]
      }>()
      .employees.find((e) => e.employee.id === s.mario)
    expect([mario?.vacation_remaining, mario?.permit_remaining]).toEqual([39, '173.50'])
  })

  it('writes nothing when a remaining is out of the range of a carry-over', async () => {
    const { browser, company } = await scene()
    const s = await staff(company.id)
    await ctx.owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
       values ($1, $2, 2025, 366)`,
      [company.id, s.mario],
    )
    await ctx.owner.query('update public.employees set annual_leave_days = 26 where id = $1', [
      s.anna,
    ])
    const before = await carryovers(company.id)
    const url = `/api/companies/${company.slug}/absences/close-year`
    const res = await browser.call('POST', url, { body: { year: 2025 } })
    expect(res.statusCode).toBe(422)
    expect(res.json<{ errors: { _: string[] } }>().errors._).toEqual([
      "Rossi Nome: ferie residue fuori dall'intervallo da -366 a 366.",
    ])
    expect(await carryovers(company.id)).toEqual(before)
  })

  it('refuses a wrong year or body, and needs employees.update, a session and CSRF', async () => {
    const { browser, company } = await scene()
    const url = `/api/companies/${company.slug}/absences/close-year`
    for (const body of [{}, { year: 1999 }, { year: 2100 }, { year: '2026' }, { year: 2026.5 }]) {
      const res = await browser.call('POST', url, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['year'])
    }
    const extra = await browser.call('POST', url, { body: { year: 2026, force: true } })
    expect(Object.keys(extra.json<{ errors: object }>().errors)).toEqual(['force'])
    expect((await browser.call('POST', url, { body: [2026] })).statusCode).toBe(422)

    const reader = await scene(['employees.view'])
    const readerUrl = `/api/companies/${reader.company.slug}/absences/close-year`
    await staff(reader.company.id)
    const before = await carryovers(reader.company.id)
    expect(
      (await reader.browser.call('POST', readerUrl, { body: { year: 2026 } })).statusCode,
    ).toBe(403)
    expect((await reader.browser.call('POST', url, { body: { year: 2026 } })).statusCode).toBe(404)
    expect(
      (await new Browser(ctx.app).call('POST', url, { body: { year: 2026 } })).statusCode,
    ).toBe(401)
    const noCsrf = await browser.call('POST', url, { body: { year: 2026 }, csrf: false })
    expect(noCsrf.statusCode).toBe(403)
    expect(await carryovers(reader.company.id)).toEqual(before)
  })
})
