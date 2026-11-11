import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addWorkingDays, subtractWorkingDays, workingDays } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface WorkingDaysStart {
  from: string
  working_days: number
  to: string
  days: number
}

async function scene(patron: string | null) {
  // No permission at all: any member asks, as for findWorkingDaysEnd.
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
  const url = `/api/companies/${company.slug}/working-days/start`
  const start = async (to: string, n: number) => {
    const res = await browser.call('GET', `${url}?to=${to}&working_days=${n}`)
    expect(res.statusCode).toBe(200)
    return res.json<WorkingDaysStart>()
  }
  return { browser, url, start }
}

describe('start of a number of working days before a day', () => {
  it('skips Christmas, Saint Stephen and the weekend', async () => {
    const s = await scene(null)
    // Monday 28 December 2026: 28, then 24, 23, 22, 21.
    expect(await s.start('2026-12-28', 5)).toEqual({
      from: '2026-12-21',
      working_days: 5,
      to: '2026-12-28',
      days: 8,
    })
    expect((await s.start('2026-12-28', 1)).from).toBe('2026-12-28')
  })

  it('starts from the last working day when to is a Sunday or a holiday', async () => {
    const s = await scene(null)
    // Sunday 15 November 2026: the last working day is Friday 13.
    expect(await s.start('2026-11-15', 1)).toEqual({
      from: '2026-11-13',
      working_days: 1,
      to: '2026-11-15',
      days: 3,
    })
    // Easter Monday 6 April 2026: Friday 3 back to Monday 30 March.
    expect((await s.start('2026-04-06', 5)).from).toBe('2026-03-30')
    // Across the new year: 7, Epiphany off, 5, 4, Friday 1 Jan off, 31, 30, 29, 28. The
    // inverse of findWorkingDaysEnd from 28 December.
    expect((await s.start('2027-01-07', 7)).from).toBe('2026-12-28')
  })

  it('agrees with countWorkingDays and findWorkingDaysEnd', () => {
    for (const to of ['2026-01-06', '2026-04-05', '2026-08-15', '2026-12-26']) {
      for (const n of [1, 2, 7, 23, 260, 500]) {
        const from = subtractWorkingDays(to, n, '06-29')
        expect(workingDays(from, to, '06-29'), `${to} - ${n}`).toBe(n)
        expect(workingDays(from, from, '06-29')).toBe(1)
        expect(workingDays(addWorkingDays(from, n, '06-29'), to, '06-29')).toBe(1)
      }
    }
  })

  it('skips the patron saint of the company, not of another one', async () => {
    const mine = await scene('06-29')
    await scene('06-26')
    // Monday 29 June 2026 is the patron saint: two working days back from Tuesday 30 start
    // on Friday 26.
    expect((await mine.start('2026-06-30', 2)).from).toBe('2026-06-26')
    const other = await scene(null)
    expect((await other.start('2026-06-30', 2)).from).toBe('2026-06-29')
  })

  it('rejects a missing or wrong date and a wrong number of days', async () => {
    const s = await scene(null)
    for (const query of [
      '',
      'to=2026-01-01',
      'working_days=3',
      'from=2026-01-01&working_days=3',
      'to=2026-02-30&working_days=3',
      'to=01/01/2026&working_days=3',
      'to=2026-01-01&working_days=0',
      'to=2026-01-01&working_days=-1',
      'to=2026-01-01&working_days=2.5',
      'to=2026-01-01&working_days=abc',
      'to=2026-01-01&working_days=501',
    ]) {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode, query).toBe(422)
    }
    expect((await s.start('2026-01-01', 500)).working_days).toBe(500)
  })

  it('answers 404 to who is not a member, 401 without a session', async () => {
    const s = await scene(null)
    const outsider = await fx.companyWithUser([])
    const browser = new Browser(ctx.app)
    await browser.signIn(outsider.user.email)
    const url = `${s.url}?to=2026-01-01&working_days=3`
    expect((await browser.call('GET', url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })
})
