import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { isHoliday } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['reports.view', 'reports.create']

async function scene(patron: string | null) {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, patron],
    )
  }
  const site = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta') returning id`,
    [company.id],
  )
  const base = `/api/companies/${company.slug}/daily-reports`
  const report = async (date: string) => {
    const res = await browser.call('POST', base, {
      body: {
        site_id: site.rows[0]?.id ?? '',
        date,
        weather: null,
        work_done: null,
        notes: null,
        labor: [],
        vehicles: [],
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json<{ id: string; holiday: boolean }>()
  }
  return { browser, base, report }
}

const csvLines = (text: string) => text.replace('﻿', '').trim().split('\r\n')

const DAYS = [
  '2026-12-05', // Saturday: not a holiday
  '2026-12-06', // Sunday
  '2026-12-07', // Monday, patron saint of the first company
  '2026-12-08', // Immacolata
  '2026-12-09', // Wednesday
  '2027-03-29', // Easter Monday 2027
]

describe('holiday flag of the daily reports', () => {
  it('knows Sundays, national holidays and the patron saint day', () => {
    expect(DAYS.map((d) => isHoliday(d, '12-07'))).toEqual([false, true, true, true, false, true])
    expect(isHoliday('2026-12-07', null)).toBe(false)
    expect(isHoliday('2026-04-06', null)).toBe(true) // Easter Monday 2026
    expect(isHoliday('2027-04-06', null)).toBe(false)
  })

  it('marks the holidays in the report, in the list and in the CSV', async () => {
    const s = await scene('12-07')
    const created = []
    for (const day of DAYS) created.push(await s.report(day))
    expect(created.map((r) => r.holiday)).toEqual([false, true, true, true, false, true])
    const one = await s.browser.call('GET', `${s.base}/${created[2]?.id ?? ''}`)
    expect(one.statusCode).toBe(200)
    expect(one.json<{ holiday: boolean }>().holiday).toBe(true)

    const list = await s.browser.call('GET', `${s.base}?sort=date`)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: { holiday: boolean }[] }>().data.map((r) => r.holiday)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
    ])
    const csv = await s.browser.call('GET', `${s.base}/export?sort=date`)
    expect(csv.statusCode).toBe(200)
    const lines = csvLines(csv.body)
    expect(lines[0]?.split(';').at(-1)).toBe('Festivo')
    expect(lines.slice(1).map((l) => l.split(';').at(-1))).toEqual([
      'No',
      'Sì',
      'Sì',
      'Sì',
      'No',
      'Sì',
    ])
  })

  it('uses the patron saint day of the company of the report, not of another one', async () => {
    const none = await scene(null)
    const other = await scene('12-09')
    expect((await none.report('2026-12-07')).holiday).toBe(false)
    expect((await other.report('2026-12-07')).holiday).toBe(false)
    expect((await other.report('2026-12-09')).holiday).toBe(true)
    const list = await none.browser.call('GET', none.base)
    expect(list.json<{ data: { holiday: boolean }[] }>().data.map((r) => r.holiday)).toEqual([
      false,
    ])
    // Another company sees neither the reports nor the CSV.
    expect((await none.browser.call('GET', `${other.base}/export`)).statusCode).toBe(404)
  })
})
