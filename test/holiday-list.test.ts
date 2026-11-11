import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nationalHolidays } from '../src/holidays.js'
import { holidaysOfYear } from '../src/routes/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface HolidayList {
  year: number
  holidays: { date: string; name: string; kind: string }[]
}

async function scene(patron: string | null) {
  // No permission at all: any member sees the holidays.
  const { company, user } = await fx.companyWithUser([])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, patron],
    )
  }
  return { browser, company, url: `/api/companies/${company.slug}/holidays` }
}

describe('holidays of the year', () => {
  it('lists the same days as the national holidays', () => {
    for (const year of [2024, 2025, 2026, 2027, 2038]) {
      expect(holidaysOfYear(year, null).map((h) => h.date)).toEqual(
        [...nationalHolidays(year)].sort(),
      )
    }
  })

  it('lists national holidays and the patron saint by date, to any member', async () => {
    const s = await scene('06-29')
    const res = await s.browser.call('GET', `${s.url}?year=2026`)
    expect(res.statusCode).toBe(200)
    const body = res.json<HolidayList>()
    expect(body.year).toBe(2026)
    expect(body.holidays.map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-01-06',
      '2026-04-06',
      '2026-04-25',
      '2026-05-01',
      '2026-06-02',
      '2026-06-29',
      '2026-08-15',
      '2026-11-01',
      '2026-12-08',
      '2026-12-25',
      '2026-12-26',
    ])
    expect(body.holidays[2]).toEqual({
      date: '2026-04-06',
      name: "Lunedì dell'Angelo",
      kind: 'national',
    })
    expect(body.holidays[6]).toEqual({
      date: '2026-06-29',
      name: 'Santo patrono',
      kind: 'patron_saint',
    })
    // Easter Monday moves with the year.
    const next = (await s.browser.call('GET', `${s.url}?year=2027`)).json<HolidayList>()
    expect(next.holidays.map((h) => h.date)).toContain('2027-03-29')
    expect(next.holidays.map((h) => h.date)).toContain('2027-06-29')
  })

  it('shows a patron saint on a national holiday once, as national', async () => {
    const s = await scene('12-08')
    const body = (await s.browser.call('GET', `${s.url}?year=2026`)).json<HolidayList>()
    expect(body.holidays).toHaveLength(11)
    expect(body.holidays.filter((h) => h.date === '2026-12-08')).toEqual([
      { date: '2026-12-08', name: 'Immacolata Concezione', kind: 'national' },
    ])
  })

  it('uses the current year without the patron saint of another company', async () => {
    await scene('06-29')
    const s = await scene(null)
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const body = res.json<HolidayList>()
    const now = new Date()
    expect([now.getUTCFullYear(), now.getUTCFullYear() + 1]).toContain(body.year)
    expect(body.holidays).toHaveLength(11)
    expect(body.holidays.every((h) => h.kind === 'national')).toBe(true)
  })

  it('rejects a wrong year', async () => {
    const s = await scene(null)
    for (const year of ['1999', '2101', 'abc', '20260']) {
      const res = await s.browser.call('GET', `${s.url}?year=${year}`)
      expect(res.statusCode).toBe(422)
    }
  })

  it('answers 404 to who is not a member, 401 without a session', async () => {
    const s = await scene('06-29')
    const outsider = await fx.companyWithUser([])
    const browser = new Browser(ctx.app)
    await browser.signIn(outsider.user.email)
    expect((await browser.call('GET', s.url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', s.url)).statusCode).toBe(401)
  })
})
