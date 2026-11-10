import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { holidaysOfMonth } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['reports.view', 'reports.create', 'employees.view']

async function scene(patron: string | null) {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)
       on conflict (company_id) do update set patron_saint_day = excluded.patron_saint_day`,
      [company.id, patron],
    )
  }
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta'), ($1, 'Condominio')
     returning id`,
    [company.id],
  )
  const employee = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name)
     values ($1, 'Luca', 'Verdi') returning id`,
    [company.id],
  )
  const base = `/api/companies/${company.slug}/daily-reports`
  const villa = sites.rows[0]?.id ?? ''
  const condo = sites.rows[1]?.id ?? ''
  const verdi = employee.rows[0]?.id ?? ''
  const report = async (site: string, date: string, hours: string) => {
    const res = await browser.call('POST', base, {
      body: {
        site_id: site,
        date,
        weather: null,
        work_done: null,
        notes: null,
        labor: [{ employee_id: verdi, hours, description: null }],
        vehicles: [],
      },
    })
    expect(res.statusCode).toBe(201)
  }
  return { browser, base, villa, condo, report }
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

describe('holiday hours in the monthly timesheets', () => {
  it('lists the national holidays and the patron saint day of a month', () => {
    expect(holidaysOfMonth('2026-11', null)).toEqual(['2026-11-01'])
    expect(holidaysOfMonth('2026-12', '12-07')).toEqual([
      '2026-12-07',
      '2026-12-08',
      '2026-12-25',
      '2026-12-26',
    ])
    // Easter Monday 2026 is 6 April.
    expect(holidaysOfMonth('2026-04', null)).toEqual(['2026-04-06', '2026-04-25'])
    expect(holidaysOfMonth('2026-02', '06-24')).toEqual([])
  })

  it('sums the hours of Sundays, national holidays and the patron saint day', async () => {
    // Patron saint on Monday 7 December 2026.
    const s = await scene('12-07')
    await s.report(s.villa, '2026-12-05', '8') // Saturday: not a holiday
    await s.report(s.villa, '2026-12-06', '4') // Sunday
    await s.report(s.condo, '2026-12-06', '2.5') // Sunday, another site
    await s.report(s.villa, '2026-12-07', '3') // patron saint
    await s.report(s.condo, '2026-12-08', '6') // Immacolata
    await s.report(s.villa, '2026-12-09', '8') // Wednesday
    await s.report(s.villa, '2027-01-01', '5') // next month

    const monthly = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-12`)
    expect(monthly.statusCode).toBe(200)
    const lines = csvLines(monthly.body)
    expect(lines[0]?.split(';').slice(-2)).toEqual(['Giorni di trasferta', 'Di cui festive'])
    expect(lines[1]?.split(';').slice(-4)).toEqual(['31,5', '0', '0', '15,5'])

    // Only one site.
    const villa = await s.browser.call(
      'GET',
      `${s.base}/monthly-hours?month=2026-12&filter[site]=${s.villa}`,
    )
    expect(csvLines(villa.body)[1]?.split(';').slice(-4)).toEqual(['23', '0', '0', '7'])

    // By site.
    const bySite = await s.browser.call('GET', `${s.base}/monthly-site-hours?month=2026-12`)
    expect(bySite.statusCode).toBe(200)
    expect(csvLines(bySite.body).slice(1)).toEqual([
      'Verdi;Luca;;Condominio;;;2;8,5;0;0;8,5',
      'Verdi;Luca;;Villetta;;;4;23;0;0;7',
    ])

    // January: New Year's day.
    const january = await s.browser.call('GET', `${s.base}/monthly-hours?month=2027-01`)
    expect(csvLines(january.body)[1]?.split(';').slice(-4)).toEqual(['5', '0', '0', '5'])
  })

  it('uses the patron saint day of its own company only', async () => {
    // Another company has its patron saint on 9 December: our 9th stays a working day.
    const theirs = await scene('12-09')
    await theirs.report(theirs.villa, '2026-12-07', '3')
    await theirs.report(theirs.villa, '2026-12-09', '8')
    const s = await scene(null)
    await s.report(s.villa, '2026-12-07', '3')
    await s.report(s.villa, '2026-12-09', '8')

    const ours = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-12`)
    const lines = csvLines(ours.body)
    expect(lines).toHaveLength(2)
    expect(lines[1]?.split(';').slice(-4)).toEqual(['11', '0', '0', '0'])
    const their = await theirs.browser.call('GET', `${theirs.base}/monthly-hours?month=2026-12`)
    expect(csvLines(their.body)[1]?.split(';').slice(-4)).toEqual(['11', '0', '0', '8'])
  })
})
