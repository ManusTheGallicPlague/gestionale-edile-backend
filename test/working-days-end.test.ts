import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addWorkingDays, workingDays } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface WorkingDaysEnd {
  from: string
  working_days: number
  to: string
  days: number
}

async function scene(patron: string | null) {
  // No permission at all: any member asks, as for countWorkingDays.
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
  const url = `/api/companies/${company.slug}/working-days/end`
  const end = async (from: string, n: number) => {
    const res = await browser.call('GET', `${url}?from=${from}&working_days=${n}`)
    expect(res.statusCode).toBe(200)
    return res.json<WorkingDaysEnd>()
  }
  return { browser, url, end }
}

describe('end of a number of working days', () => {
  it('skips Christmas, Saint Stephen and the weekend', async () => {
    const s = await scene(null)
    // Monday 21 December 2026: 21, 22, 23, 24, then Monday 28.
    expect(await s.end('2026-12-21', 5)).toEqual({
      from: '2026-12-21',
      working_days: 5,
      to: '2026-12-28',
      days: 8,
    })
    expect((await s.end('2026-12-21', 1)).to).toBe('2026-12-21')
  })

  it('starts from the first working day when from is a Saturday or a holiday', async () => {
    const s = await scene(null)
    // Saturday 14 November 2026: the first working day is Monday 16.
    expect(await s.end('2026-11-14', 1)).toEqual({
      from: '2026-11-14',
      working_days: 1,
      to: '2026-11-16',
      days: 3,
    })
    // Easter Monday 6 April 2026: Tuesday 7 to Friday 10, then Monday 13.
    expect((await s.end('2026-04-06', 5)).to).toBe('2026-04-13')
    // Across the new year: 28-31 Dec, Friday 1 Jan off, 4, 5, Epiphany off, 7.
    expect((await s.end('2026-12-28', 7)).to).toBe('2027-01-07')
  })

  it('agrees with countWorkingDays and always ends on a working day', () => {
    for (const from of ['2026-01-01', '2026-04-04', '2026-08-14', '2026-12-24']) {
      for (const n of [1, 2, 7, 23, 260, 500]) {
        const to = addWorkingDays(from, n, '06-29')
        expect(workingDays(from, to, '06-29'), `${from} + ${n}`).toBe(n)
        expect(workingDays(to, to, '06-29')).toBe(1)
      }
    }
  })

  it('skips the patron saint of the company, not of another one', async () => {
    const mine = await scene('06-29')
    await scene('06-30')
    // Monday 29 June 2026 is the patron saint: two working days end on Wednesday 1 July.
    expect((await mine.end('2026-06-29', 2)).to).toBe('2026-07-01')
    const other = await scene(null)
    expect((await other.end('2026-06-29', 2)).to).toBe('2026-06-30')
  })

  it('rejects a missing or wrong date and a wrong number of days', async () => {
    const s = await scene(null)
    for (const query of [
      '',
      'from=2026-01-01',
      'working_days=3',
      'from=2026-02-30&working_days=3',
      'from=01/01/2026&working_days=3',
      'from=2026-01-01&working_days=0',
      'from=2026-01-01&working_days=-1',
      'from=2026-01-01&working_days=2.5',
      'from=2026-01-01&working_days=abc',
      'from=2026-01-01&working_days=501',
    ]) {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode, query).toBe(422)
    }
    expect((await s.end('2026-01-01', 500)).working_days).toBe(500)
  })

  it('answers 404 to who is not a member, 401 without a session', async () => {
    const s = await scene(null)
    const outsider = await fx.companyWithUser([])
    const browser = new Browser(ctx.app)
    await browser.signIn(outsider.user.email)
    const url = `${s.url}?from=2026-01-01&working_days=3`
    expect((await browser.call('GET', url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })
})
