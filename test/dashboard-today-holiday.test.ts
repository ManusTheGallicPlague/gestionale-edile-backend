import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isHoliday } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface Dashboard {
  today: string
  today_holiday: boolean
  reports: { missing_today: number | null } | null
}

async function scene(permissions: Parameters<Fixtures['companyWithUser']>[0]) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  async function dashboard(): Promise<Dashboard> {
    const res = await browser.call('GET', `/api/companies/${company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    return res.json<Dashboard>()
  }
  async function patron(dayOfYear: string) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, dayOfYear],
    )
  }
  return { company, dashboard, patron }
}

describe('today holiday in the dashboard', () => {
  it('follows the rule of the daily reports, without any permission', async () => {
    const s = await scene([])
    const d = await s.dashboard()
    expect(d.today_holiday).toBe(isHoliday(d.today, null))
    expect(d.reports).toBeNull()
  })

  it('is true on the patron saint day of the company, not on that of another company', async () => {
    const s = await scene(['reports.view', 'sites.view'])
    const other = await scene(['reports.view', 'sites.view'])
    const today = (await s.dashboard()).today
    await s.patron(today.slice(5))
    await ctx.owner.query(
      `insert into public.sites (company_id, name, status) values ($1, 'Scuola', 'active')`,
      [s.company.id],
    )

    const mine = await s.dashboard()
    expect(mine.today_holiday).toBe(true)
    // missing_today keeps counting: the frontend decides whether to show it on a holiday.
    expect(mine.reports?.missing_today).toBe(1)

    const theirs = await other.dashboard()
    expect(theirs.today_holiday).toBe(isHoliday(theirs.today, null))
  })
})
