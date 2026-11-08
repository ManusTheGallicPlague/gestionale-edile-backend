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

type Kinds = { kind: string; days: number; hours: string }[]
type Totals = {
  year: number
  from: string
  to: string
  employees: {
    employee: { id: string; first_name: string; last_name: string; active: boolean }
    days: number
    hours: string
    kinds: Kinds
  }[]
  totals: { days: number; hours: string; kinds: Kinds }
}

const zero = (overrides: Record<string, [number, string]> = {}): Kinds =>
  ['vacation', 'sick_leave', 'leave', 'injury', 'other'].map((kind) => {
    const [days, hours] = overrides[kind] ?? [0, '0.00']
    return { kind, days, hours }
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
      days: 0,
      hours: '0.00',
      kinds: zero(),
    })
    expect(body.employees[1]).toMatchObject({
      days: 18,
      hours: '3.75',
      kinds: zero({ vacation: [16, '0.00'], sick_leave: [2, '0.00'], leave: [0, '3.75'] }),
    })
    expect(body.employees[2]).toMatchObject({
      employee: { active: false },
      days: 5,
      kinds: zero({ injury: [5, '0.00'] }),
    })
    expect(body.totals).toEqual({
      days: 23,
      hours: '3.75',
      kinds: zero({
        vacation: [16, '0.00'],
        sick_leave: [2, '0.00'],
        leave: [0, '3.75'],
        injury: [5, '0.00'],
      }),
    })

    const next = (await s.browser.call('GET', `${s.url}?year=2027`)).json<Totals>()
    expect(next.employees.map((e) => [e.employee.id, e.days])).toEqual([
      [s.anna, 0],
      [s.mario, 4],
    ])
    const before = (await s.browser.call('GET', `${s.url}?year=2025`)).json<Totals>()
    expect(before.employees.map((e) => [e.employee.id, e.days])).toEqual([
      [s.anna, 0],
      [s.idle, 5],
      [s.mario, 2],
    ])
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
    const res = await s.browser.call('GET', `${s.url}/export?year=2026`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="assenze-2026.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Cognome;Nome;Ferie giorni;Ferie ore;Malattia giorni;Malattia ore;Permesso giorni;Permesso ore;Infortunio giorni;Infortunio ore;Altro giorni;Altro ore;Totale giorni;Totale ore',
      "'=SUM(A1);Anna;0;0;0;0;0;0;0;0;0;0;0;0",
      'Rossi;Mario;16;0;2;0;0;3,75;0;0;0;0;18;3,75',
      'Verdi;Luca;0;0;0;0;0;0;5;0;0;0;5;0',
      'Totale;;16;0;2;0;0;3,75;5;0;0;0;23;3,75',
    ])
    expect((await s.browser.call('GET', `${s.url}/export?year=x`)).statusCode).toBe(422)
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
