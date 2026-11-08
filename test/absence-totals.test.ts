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

type Kinds = { kind: string; days: number; working_days: number; hours: string }[]
type Totals = {
  year: number
  from: string
  to: string
  employees: {
    employee: { id: string; first_name: string; last_name: string; active: boolean }
    vacation_allowance: number | null
    vacation_carried_over: number | null
    vacation_remaining: number | null
    permit_allowance: number | null
    permit_carried_over: string | null
    permit_remaining: string | null
    days: number
    working_days: number
    hours: string
    kinds: Kinds
  }[]
  totals: { days: number; working_days: number; hours: string; kinds: Kinds }
}

const zero = (overrides: Record<string, [number, number, string]> = {}): Kinds =>
  ['vacation', 'sick_leave', 'leave', 'injury', 'other'].map((kind) => {
    const [days, working_days, hours] = overrides[kind] ?? [0, 0, '0.00']
    return { kind, days, working_days, hours }
  })

async function scene(permissions: Permission[] = ['employees.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const employee = async (first: string, last: string, active = true) => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.employees (company_id, first_name, last_name, active)
       values ($1, $2, $3, $4) returning id`,
      [company.id, first, last, active],
    )
    return rows[0]?.id ?? ''
  }
  const absence = (id: string, kind: string, starts: string, ends: string, hours?: string) =>
    ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
       values ($1, $2, $3, $4, $5, $6, 'x')`,
      [company.id, id, kind, starts, ends, hours ?? null],
    )
  const mario = await employee('Mario', 'Rossi')
  const anna = await employee('Anna', 'Bianchi')
  const gone = await employee('Luca', 'Verdi', false)
  const idle = await employee('Piero', 'Neri', false)
  // Christmas holidays across the new year: 4 days in 2026, 4 in 2027.
  await absence(mario, 'vacation', '2026-12-28', '2027-01-04')
  await absence(mario, 'vacation', '2026-08-10', '2026-08-21')
  await absence(mario, 'leave', '2026-09-03', '2026-09-03', '2.5')
  await absence(mario, 'leave', '2026-09-04', '2026-09-04', '1.25')
  await absence(mario, 'sick_leave', '2025-12-30', '2026-01-02')
  await absence(gone, 'injury', '2026-03-02', '2026-03-06')
  await absence(idle, 'vacation', '2025-08-04', '2025-08-08')
  const url = `/api/companies/${company.slug}/absences/totals`
  return { browser, company, url, mario, anna, gone, idle }
}

describe('absence totals of the year', () => {
  it('sums days and hours per employee and kind, clipped to the year', async () => {
    const s = await scene()
    const theirs = await scene() // another company with the same absences
    const res = await s.browser.call('GET', `${s.url}?year=2026`)
    expect(res.statusCode).toBe(200)
    const body = res.json<Totals>()
    expect(body).toMatchObject({ year: 2026, from: '2026-01-01', to: '2026-12-31' })
    // Active employees even without absences, inactive ones only with absences, by surname.
    expect(body.employees.map((e) => e.employee.id)).toEqual([s.anna, s.mario, s.gone])
    for (const id of [theirs.mario, theirs.anna, theirs.gone, s.idle]) {
      expect(res.body).not.toContain(id)
    }
    expect(body.employees[0]).toEqual({
      employee: { id: s.anna, first_name: 'Anna', last_name: 'Bianchi', active: true },
      vacation_allowance: null,
      vacation_carried_over: null,
      vacation_remaining: null,
      permit_allowance: null,
      permit_carried_over: null,
      permit_remaining: null,
      days: 0,
      working_days: 0,
      hours: '0.00',
      kinds: zero(),
    })
    expect(body.employees[1]).toMatchObject({
      days: 18,
      // 28–31/12 and 10–21/08 (15/08 is a Saturday); 01/01 is a holiday.
      working_days: 15,
      hours: '3.75',
      kinds: zero({
        vacation: [16, 14, '0.00'],
        sick_leave: [2, 1, '0.00'],
        leave: [0, 0, '3.75'],
      }),
    })
    expect(body.employees[2]).toMatchObject({
      employee: { active: false },
      days: 5,
      working_days: 5,
      kinds: zero({ injury: [5, 5, '0.00'] }),
    })
    expect(body.totals).toEqual({
      days: 23,
      working_days: 20,
      hours: '3.75',
      kinds: zero({
        vacation: [16, 14, '0.00'],
        sick_leave: [2, 1, '0.00'],
        leave: [0, 0, '3.75'],
        injury: [5, 5, '0.00'],
      }),
    })

    const next = (await s.browser.call('GET', `${s.url}?year=2027`)).json<Totals>()
    expect(next.employees.map((e) => [e.employee.id, e.days, e.working_days])).toEqual([
      [s.anna, 0, 0],
      [s.mario, 4, 1],
    ])
    const before = (await s.browser.call('GET', `${s.url}?year=2025`)).json<Totals>()
    expect(before.employees.map((e) => [e.employee.id, e.days, e.working_days])).toEqual([
      [s.anna, 0, 0],
      [s.idle, 5, 5],
      [s.mario, 2, 2],
    ])
  })

  it('counts the remaining vacation from the yearly allowance', async () => {
    const s = await scene()
    const theirs = await scene()
    const set = (id: string, days: number | null) =>
      ctx.owner.query('update public.employees set annual_leave_days = $2 where id = $1', [
        id,
        days,
      ])
    await set(s.mario, 26)
    await set(s.anna, 20)
    await set(s.gone, 10)
    await set(theirs.mario, 1) // another company: its allowance does not count here
    const year = (y: number) =>
      s.browser
        .call('GET', `${s.url}?year=${y}`)
        .then((r) => r.json<Totals>())
        .then((t) =>
          t.employees.map((e) => [e.employee.id, e.vacation_allowance, e.vacation_remaining]),
        )
    // Mario: 14 working days of vacation in 2026, only 1 (04/01) in 2027; the injury of
    // Luca and the sick leave of Mario are not vacation.
    expect(await year(2026)).toEqual([
      [s.anna, 20, 20],
      [s.mario, 26, 12],
      [s.gone, 10, 10],
    ])
    expect(await year(2027)).toEqual([
      [s.anna, 20, 20],
      [s.mario, 26, 25],
    ])
    // More vacation than allowed goes below zero; no allowance, no count.
    await set(s.mario, 10)
    await set(s.anna, null)
    expect(await year(2026)).toEqual([
      [s.anna, null, null],
      [s.mario, 10, -4],
      [s.gone, 10, 10],
    ])
  })

  it('counts the remaining leave hours, a whole-day leave as 8 hours a working day', async () => {
    const s = await scene()
    const theirs = await scene()
    const set = (id: string, hours: number | null) =>
      ctx.owner.query('update public.employees set annual_permit_hours = $2 where id = $1', [
        id,
        hours,
      ])
    await set(s.mario, 88)
    await set(s.anna, 32)
    await set(theirs.mario, 1) // another company: its hours do not count here
    // Mario, besides 2.5 + 1.25 hours in September: a whole-day leave from Friday 30/10 to
    // Monday 02/11 (2 working days) and one across the new year (31/12, then 01/01 a holiday).
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, notes)
       values ($1, $2, 'leave', '2026-10-30', '2026-11-02', 'x'),
              ($1, $2, 'leave', '2026-12-31', '2027-01-01', 'x')`,
      [s.company.id, s.mario],
    )
    const year = (y: number) =>
      s.browser
        .call('GET', `${s.url}?year=${y}`)
        .then((r) => r.json<Totals>())
        .then((t) =>
          t.employees.map((e) => [e.employee.id, e.permit_allowance, e.permit_remaining]),
        )
    // 88 - 3.75 - 3 working days × 8 hours.
    expect(await year(2026)).toEqual([
      [s.anna, 32, '32.00'],
      [s.mario, 88, '60.25'],
      [s.gone, null, null],
    ])
    expect(await year(2027)).toEqual([
      [s.anna, 32, '32.00'],
      [s.mario, 88, '88.00'],
    ])
    // More leave than allowed goes below zero, with the hundredths kept exact.
    await set(s.mario, 20)
    await set(s.anna, null)
    expect(await year(2026)).toEqual([
      [s.anna, null, null],
      [s.mario, 20, '-7.75'],
      [s.gone, null, null],
    ])
    const csv = await s.browser.call('GET', `${s.url}/export?year=2026`)
    expect(csv.body).toContain('Rossi;Mario;')
    expect(csv.body.split('\r\n').find((l) => l.startsWith('Rossi;'))).toMatch(/;20;-7,75$/)
  })

  it('adds the vacation carried over into the year, only of that year and company', async () => {
    const s = await scene()
    const theirs = await scene()
    await ctx.owner.query('update public.employees set annual_leave_days = 26 where id = $1', [
      s.mario,
    ])
    const carry = (company: string, id: string, year: number, days: number) =>
      ctx.owner.query(
        `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
         values ($1, $2, $3, $4)`,
        [company, id, year, days],
      )
    await carry(s.company.id, s.mario, 2026, 5)
    await carry(s.company.id, s.mario, 2027, -3) // taken in advance
    await carry(s.company.id, s.anna, 2026, 4) // no allowance: nothing remains to count
    await carry(theirs.company.id, theirs.mario, 2026, 100)
    const year = (y: number) =>
      s.browser
        .call('GET', `${s.url}?year=${y}`)
        .then((r) => r.json<Totals>())
        .then((t) =>
          t.employees.map((e) => [
            e.employee.id,
            e.vacation_carried_over,
            e.vacation_allowance,
            e.vacation_remaining,
          ]),
        )
    expect(await year(2026)).toEqual([
      [s.anna, 4, null, null],
      [s.mario, 5, 26, 17],
      [s.gone, null, null, null],
    ])
    expect(await year(2027)).toEqual([
      [s.anna, null, null, null],
      [s.mario, -3, 26, 22],
    ])
    // Another year without a carry-over counts only the allowance.
    expect(await year(2028)).toEqual([
      [s.anna, null, null, null],
      [s.mario, null, 26, 26],
    ])
  })

  it('adds the leave hours carried over into the year, only of that year and company', async () => {
    const s = await scene()
    const theirs = await scene()
    await ctx.owner.query('update public.employees set annual_permit_hours = 8 where id = $1', [
      s.mario,
    ])
    const carry = (company: string, id: string, year: number, days: number | null, hours: string) =>
      ctx.owner.query(
        `insert into public.employee_leave_carryovers (company_id, employee_id, year, days, permit_hours)
         values ($1, $2, $3, $4, $5)`,
        [company, id, year, days, hours],
      )
    await carry(s.company.id, s.mario, 2026, null, '0.25') // hours without vacation days
    await carry(s.company.id, s.mario, 2027, 2, '-12.5') // taken in advance
    await carry(s.company.id, s.anna, 2026, null, '6') // no allowance: nothing remains to count
    await carry(theirs.company.id, theirs.mario, 2026, null, '1000')
    const year = (y: number, filter = '') =>
      s.browser
        .call('GET', `${s.url}?year=${y}${filter}`)
        .then((r) => r.json<Totals>())
        .then((t) =>
          t.employees.map((e) => [
            e.employee.id,
            e.permit_carried_over,
            e.vacation_carried_over,
            e.permit_remaining,
          ]),
        )
    // 8 + 0.25 - 3.75 hours of September.
    expect(await year(2026)).toEqual([
      [s.anna, '6.00', null, null],
      [s.mario, '0.25', null, '4.50'],
      [s.gone, null, null, null],
    ])
    // 8 - 12.5: below zero, so among those who took too much.
    expect(await year(2027)).toEqual([
      [s.anna, null, null, null],
      [s.mario, '-12.50', 2, '-4.50'],
    ])
    expect(await year(2027, '&filter[permit]=exceeded')).toEqual([[s.mario, '-12.50', 2, '-4.50']])
    expect(await year(2026, '&filter[permit]=exceeded')).toEqual([])
  })

  it('takes the current year in Italy without a year, and refuses a wrong one', async () => {
    const s = await scene()
    const { rows } = await ctx.owner.query<{ year: number }>(
      "select extract(year from now() at time zone 'Europe/Rome')::int as year",
    )
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    expect(res.json<Totals>().year).toBe(rows[0]?.year)
    for (const year of ['1999', '2101', '26', 'duemila', '2026.5']) {
      const wrong = await s.browser.call('GET', `${s.url}?year=${year}`)
      expect(wrong.statusCode).toBe(422)
      expect(Object.keys(wrong.json<{ errors: object }>().errors)).toEqual(['year'])
    }
    expect((await s.browser.call('GET', `${s.url}?year=2026&year=2027`)).statusCode).toBe(422)
  })

  it('exports the same rows as CSV with a total, for the payroll office', async () => {
    const s = await scene()
    await ctx.owner.query("update public.employees set last_name = '=SUM(A1)' where id = $1", [
      s.anna,
    ])
    await ctx.owner.query(
      'update public.employees set annual_leave_days = 26, annual_permit_hours = 8 where id = $1',
      [s.mario],
    )
    await ctx.owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days, permit_hours)
       values ($1, $2, 2026, -2, 2.5)`,
      [s.company.id, s.mario],
    )
    const res = await s.browser.call('GET', `${s.url}/export?year=2026`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="assenze-2026.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Cognome;Nome;Ferie giorni;Ferie giorni lavorativi;Ferie ore;Malattia giorni;Malattia giorni lavorativi;Malattia ore;Permesso giorni;Permesso giorni lavorativi;Permesso ore;Infortunio giorni;Infortunio giorni lavorativi;Infortunio ore;Altro giorni;Altro giorni lavorativi;Altro ore;Totale giorni;Totale giorni lavorativi;Totale ore;Ferie anno precedente;Ferie spettanti;Ferie residue;Permessi anno precedente (ore);Permessi spettanti (ore);Permessi residui (ore)',
      "'=SUM(A1);Anna;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;;;;;;",
      'Rossi;Mario;16;14;0;2;1;0;0;0;3,75;0;0;0;0;0;0;18;15;3,75;-2;26;10;2,5;8;6,75',
      'Verdi;Luca;0;0;0;0;0;0;0;0;0;5;5;0;0;0;0;5;5;0;;;;;;',
      'Totale;;16;14;0;2;1;0;0;0;3,75;5;5;0;0;0;0;23;20;3,75;;;;;;',
    ])
    expect((await s.browser.call('GET', `${s.url}/export?year=x`)).statusCode).toBe(422)
  })

  it('filters one employee, active or not, for the employee page', async () => {
    const s = await scene()
    const theirs = await scene()
    const only = async (id: string, year = 2026) => {
      const res = await s.browser.call('GET', `${s.url}?year=${year}&filter[employee]=${id}`)
      expect(res.statusCode).toBe(200)
      return res.json<Totals>()
    }
    const mario = await only(s.mario)
    expect(mario.employees.map((e) => e.employee.id)).toEqual([s.mario])
    // The total is the one of the listed employee, not of the company.
    expect(mario.totals).toMatchObject({ days: 18, working_days: 15, hours: '3.75' })
    // Not active and without absences in the year: still there, with zeros.
    const idle = await only(s.idle)
    expect(idle.employees).toHaveLength(1)
    expect(idle.employees[0]).toMatchObject({
      employee: { id: s.idle, active: false },
      days: 0,
      kinds: zero(),
    })
    expect(idle.totals).toMatchObject({ days: 0, working_days: 0, hours: '0.00' })
    expect((await only(s.idle, 2025)).totals.days).toBe(5)
    // An employee of another company, or one that does not exist: an empty list.
    for (const id of [theirs.mario, '00000000-0000-4000-8000-000000000000']) {
      const other = await only(id)
      expect(other.employees).toEqual([])
      expect(other.totals).toEqual({ days: 0, working_days: 0, hours: '0.00', kinds: zero() })
    }
    // Upper case ids are the same id.
    expect((await only(s.mario.toUpperCase())).employees).toHaveLength(1)
    const csv = await s.browser.call('GET', `${s.url}/export?year=2026&filter[employee]=${s.mario}`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      expect.stringMatching(/^Cognome;Nome;/),
      'Rossi;Mario;16;14;0;2;1;0;0;0;3,75;0;0;0;0;0;0;18;15;3,75;;;;;;',
      'Totale;;16;14;0;2;1;0;0;0;3,75;0;0;0;0;0;0;18;15;3,75;;;;;;',
    ])
  })

  it('keeps only who took more vacation than allowed', async () => {
    const s = await scene()
    const theirs = await scene()
    const set = (id: string, days: number) =>
      ctx.owner.query('update public.employees set annual_leave_days = $2 where id = $1', [
        id,
        days,
      ])
    await set(s.mario, 10) // 14 working days of vacation in 2026: -4
    await set(s.anna, 0) // no vacation: exactly 0 left, not exceeded
    await set(theirs.mario, 1) // another company
    const exceeded = async (query = '') => {
      const res = await s.browser.call(
        'GET',
        `${s.url}?year=2026&filter[vacation]=exceeded${query}`,
      )
      expect(res.statusCode).toBe(200)
      return res.json<Totals>()
    }
    const body = await exceeded()
    // Luca has no allowance at all: not counted as exceeded.
    expect(body.employees.map((e) => [e.employee.id, e.vacation_remaining])).toEqual([
      [s.mario, -4],
    ])
    expect(body.totals).toMatchObject({ days: 18, working_days: 15 })
    // A carry-over can bring it back to zero.
    await ctx.owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
       values ($1, $2, 2026, 4)`,
      [s.company.id, s.mario],
    )
    expect((await exceeded()).employees).toEqual([])
    // Vacation taken in advance last year, with no vacation this year: -1.
    await ctx.owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
       values ($1, $2, 2026, -1)`,
      [s.company.id, s.anna],
    )
    expect((await exceeded()).employees.map((e) => e.employee.id)).toEqual([s.anna])
    // Both filters together.
    expect((await exceeded(`&filter[employee]=${s.mario}`)).employees).toEqual([])
    const csv = await s.browser.call('GET', `${s.url}/export?year=2026&filter[vacation]=exceeded`)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toHaveLength(3)
  })

  it('keeps only who took more leave hours than allowed', async () => {
    const s = await scene()
    const theirs = await scene()
    const set = (id: string, hours: number) =>
      ctx.owner.query('update public.employees set annual_permit_hours = $2 where id = $1', [
        id,
        hours,
      ])
    await set(s.mario, 3) // 3.75 hours of leave in 2026: -0.75
    await set(s.anna, 0) // no leave: exactly 0 left, not exceeded
    await set(theirs.mario, 1) // another company
    const exceeded = async (query = '') => {
      const res = await s.browser.call('GET', `${s.url}?year=2026&filter[permit]=exceeded${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<Totals>()
    }
    const body = await exceeded()
    // Luca has no hours at all: not counted as exceeded.
    expect(body.employees.map((e) => [e.employee.id, e.permit_remaining])).toEqual([
      [s.mario, '-0.75'],
    ])
    expect(body.totals).toMatchObject({ days: 18, hours: '3.75' })
    expect((await exceeded(`&filter[employee]=${s.anna}`)).employees).toEqual([])
    // With the vacation filter too, only who exceeded both.
    expect((await exceeded('&filter[vacation]=exceeded')).employees).toEqual([])
    await ctx.owner.query('update public.employees set annual_leave_days = 10 where id = $1', [
      s.mario,
    ])
    expect(
      (await exceeded('&filter[vacation]=exceeded')).employees.map((e) => e.employee.id),
    ).toEqual([s.mario])
    const csv = await s.browser.call('GET', `${s.url}/export?year=2026&filter[permit]=exceeded`)
    expect(csv.body.replace('\ufeff', '').trim().split('\r\n')).toHaveLength(3)
    // Exactly at zero is not exceeded.
    await set(s.mario, 4)
    expect((await exceeded()).employees).toEqual([])
  })

  it('refuses wrong filters', async () => {
    const s = await scene()
    for (const [query, field] of [
      ['filter[employee]=abc', 'filter[employee]'],
      [`filter[employee]=${s.mario}&filter[employee]=${s.anna}`, 'filter[employee]'],
      ['filter[vacation]=remaining', 'filter[vacation]'],
      ['filter[vacation]=', 'filter[vacation]'],
      ['filter[permit]=remaining', 'filter[permit]'],
      ['filter[permit]=exceeded&filter[permit]=exceeded', 'filter[permit]'],
    ]) {
      for (const path of [s.url, `${s.url}/export`]) {
        const res = await s.browser.call('GET', `${path}?year=2026&${query}`)
        expect(res.statusCode).toBe(422)
        expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
      }
    }
  })

  it('needs employees.view, a session and a company of the user', async () => {
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', `${blind.url}/export`)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', blind.url)).statusCode).toBe(401)
    expect((await new Browser(ctx.app).call('GET', `${blind.url}/export`)).statusCode).toBe(401)
    const s = await scene()
    const elsewhere = blind.url.replace(blind.company.slug, s.company.slug)
    expect((await blind.browser.call('GET', elsewhere)).statusCode).toBe(404)
  })
})
