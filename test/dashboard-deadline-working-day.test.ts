import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nextWorkingDay } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface DashboardDeadline {
  title: string
  due_on: string
  working_due_on: string
  overdue: boolean
}

/** Dates relative to today in Italy, as the API counts them. */
async function day(offset: number): Promise<string> {
  const { rows } = await ctx.owner.query<{ d: string }>(
    "select ((now() at time zone 'Europe/Rome')::date + $1::int)::text as d",
    [offset],
  )
  return rows[0]?.d ?? ''
}

/** Days from today to the next Saturday (1..7). */
async function untilSaturday(): Promise<number> {
  const { rows } = await ctx.owner.query<{ n: number }>(
    "select ((6 - extract(isodow from (now() at time zone 'Europe/Rome')::date)::int + 7) % 7)::int as n",
  )
  const n = rows[0]?.n ?? 0
  return n === 0 ? 7 : n
}

async function scene() {
  const { company, user } = await fx.companyWithUser(['deadlines.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  async function dashboard(): Promise<DashboardDeadline[]> {
    const res = await browser.call('GET', `/api/companies/${company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    return res.json<{ deadlines: DashboardDeadline[] }>().deadlines
  }
  async function deadline(title: string, dueOn: string) {
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind, status)
       values ($1, $2, $3, 'tax', 'open')`,
      [company.id, title, dueOn],
    )
  }
  async function patron(companyId: string, dayOfYear: string) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [companyId, dayOfYear],
    )
  }
  return { company, dashboard, deadline, patron }
}

describe('first working day in the dashboard deadlines', () => {
  it('moves a Saturday deadline to the next working day and keeps overdue on due_on', async () => {
    const s = await scene()
    const saturday = await day(await untilSaturday())
    const past = await day(-3)
    await s.deadline('Sabato', saturday)
    await s.deadline('Scaduta', past)

    const deadlines = await s.dashboard()
    expect(deadlines.map((d) => [d.title, d.due_on, d.working_due_on, d.overdue])).toEqual([
      ['Scaduta', past, nextWorkingDay(past, null), true],
      ['Sabato', saturday, nextWorkingDay(saturday, null), false],
    ])
    expect(deadlines[1]?.working_due_on).not.toBe(saturday)
  })

  it('counts the patron saint of the company, not that of another company', async () => {
    const s = await scene()
    const other = await scene()
    const saturday = await day(await untilSaturday())
    const monday = await day((await untilSaturday()) + 2)
    // The patron saint falls on the Monday after: the Saturday deadline slips further.
    await s.patron(s.company.id, monday.slice(5))
    await s.deadline('Sabato', saturday)
    await other.deadline('Sabato', saturday)

    const mine = await s.dashboard()
    expect(mine[0]?.working_due_on).toBe(nextWorkingDay(saturday, monday.slice(5)))
    expect((mine[0]?.working_due_on ?? '') > monday).toBe(true)

    const theirs = await other.dashboard()
    expect(theirs[0]?.working_due_on).toBe(nextWorkingDay(saturday, null))
  })
})
