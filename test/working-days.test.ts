import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { workingDays } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface WorkingDays {
  from: string
  to: string
  days: number
  working_days: number
  holidays: { date: string; name: string; kind: string }[]
}

async function scene(patron: string | null) {
  // No permission at all: any member counts the working days.
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
  const url = `/api/companies/${company.slug}/working-days`
  const count = async (from: string, to: string) => {
    const res = await browser.call('GET', `${url}?from=${from}&to=${to}`)
    expect(res.statusCode).toBe(200)
    return res.json<WorkingDays>()
  }
  return { browser, url, count }
}

describe('working days between two dates', () => {
  it('skips weekends, Christmas and Saint Stephen, and lists them', async () => {
    const s = await scene(null)
    // Monday 21 to Sunday 27 December 2026: Friday 25 and Saturday 26 are holidays.
    const body = await s.count('2026-12-21', '2026-12-27')
    expect(body).toEqual({
      from: '2026-12-21',
      to: '2026-12-27',
      days: 7,
      working_days: 4,
      holidays: [
        { date: '2026-12-25', name: 'Natale', kind: 'national' },
        { date: '2026-12-26', name: 'Santo Stefano', kind: 'national' },
      ],
    })
  })

  it('counts a single day, Easter Monday and a period across the new year', async () => {
    const s = await scene(null)
    expect((await s.count('2026-11-11', '2026-11-11')).working_days).toBe(1)
    expect((await s.count('2026-11-14', '2026-11-14')).working_days).toBe(0)
    const easter = await s.count('2026-04-06', '2026-04-10')
    expect(easter.working_days).toBe(4)
    expect(easter.holidays.map((h) => h.name)).toEqual(["Lunedì dell'Angelo"])
    const across = await s.count('2026-12-28', '2027-01-08')
    expect(across.days).toBe(12)
    // 28-31 Dec (4), 4-8 Jan without Epiphany on Wednesday 6 (4); 1 Jan is a Friday.
    expect(across.working_days).toBe(8)
    expect(across.holidays.map((h) => h.date)).toEqual(['2027-01-01', '2027-01-06'])
    expect(across.working_days).toBe(workingDays('2026-12-28', '2027-01-08'))
  })

  it('removes the patron saint of the company, not of another one', async () => {
    const mine = await scene('06-29')
    await scene('06-30')
    // Monday 29 to Tuesday 30 June 2026.
    const body = await mine.count('2026-06-29', '2026-06-30')
    expect(body.working_days).toBe(1)
    expect(body.holidays).toEqual([
      { date: '2026-06-29', name: 'Santo patrono', kind: 'patron_saint' },
    ])
    const other = await scene(null)
    expect((await other.count('2026-06-29', '2026-06-30')).working_days).toBe(2)
  })

  it('rejects missing or wrong dates, a reversed and a too long period', async () => {
    const s = await scene(null)
    for (const query of [
      '',
      'from=2026-01-01',
      'to=2026-01-01',
      'from=2026-02-30&to=2026-03-01',
      'from=01/01/2026&to=2026-03-01',
      'from=2026-03-02&to=2026-03-01',
      'from=2026-01-01&to=2028-01-02',
    ]) {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode, query).toBe(422)
    }
    // Two years exactly are accepted.
    expect((await s.count('2026-01-01', '2028-01-01')).days).toBe(731)
  })

  it('answers 404 to who is not a member, 401 without a session', async () => {
    const s = await scene(null)
    const outsider = await fx.companyWithUser([])
    const browser = new Browser(ctx.app)
    await browser.signIn(outsider.user.email)
    const url = `${s.url}?from=2026-01-01&to=2026-01-31`
    expect((await browser.call('GET', url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })
})
