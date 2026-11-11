import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'
import { workingDays } from '../src/holidays.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

/** Today in Italy, AAAA-MM-GG, as the backend sees it. */
async function today(): Promise<string> {
  const { rows } = await ctx.owner.query<{ today: string }>(
    "select ((now() at time zone 'Europe/Rome')::date)::text as today",
  )
  return rows[0]?.today ?? ''
}

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

async function scene(patron: string | null) {
  const { company, user } = await fx.companyWithUser(['sites.view', 'sites.update'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name, code, status) values ($1, 'Villetta', 'V1', 'active') returning id",
    [company.id],
  )
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, patron],
    )
  }
  return {
    browser,
    url: `/api/companies/${company.slug}/sites/${site.rows[0]?.id ?? ''}/activities`,
    companyUrl: `/api/companies/${company.slug}/activities`,
  }
}

const body = (name: string, start_on: string, end_on: string, progress = 0) => ({
  name,
  start_on,
  end_on,
  progress,
  depends_on: [],
  notes: null,
})

interface Item {
  name: string
  working_days: number
  remaining_working_days: number
}

describe('remaining working days of the schedule activities', () => {
  it('counts from today, or from the start, to the end of an unfinished activity', async () => {
    const s = await scene(null)
    const day = await today()
    // Future: 2-6/12/2030, five weekdays without holidays.
    await s.browser.call('POST', s.url, { body: body('Futura', '2030-12-02', '2030-12-06') })
    // 23/12/2030-03/01/2031: 10 weekdays, 7 without Christmas, St Stephen and New Year.
    await s.browser.call('POST', s.url, { body: body('Natale', '2030-12-23', '2031-01-03') })
    // Started in the past, ends in the future: from today.
    const end = shift(day, 40)
    await s.browser.call('POST', s.url, { body: body('In corso', shift(day, -10), end, 30) })
    // Ended in the past, not finished: late, nothing remains.
    await s.browser.call('POST', s.url, {
      body: body('In ritardo', shift(day, -20), shift(day, -5), 50),
    })
    // Finished ahead of time.
    await s.browser.call('POST', s.url, { body: body('Finita', '2030-12-02', '2030-12-06', 100) })

    const list = await s.browser.call('GET', s.companyUrl)
    expect(list.statusCode).toBe(200)
    const items = new Map(
      list.json<{ data: Item[] }>().data.map((a) => [a.name, a.remaining_working_days]),
    )
    expect(Object.fromEntries(items)).toEqual({
      Futura: 5,
      Natale: 7,
      'In corso': workingDays(day, end),
      'In ritardo': 0,
      Finita: 0,
    })

    const csv = await s.browser.call('GET', `${s.companyUrl}/export`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.replace('﻿', '').split('\r\n')
    expect(lines[0]).toBe(
      'Cantiere;Codice cantiere;Attività;Inizio;Fine;Avanzamento %;Giorni di ritardo;Note;Giorni lavorativi;Giorni lavorativi rimanenti',
    )
    expect(lines.find((l) => l.includes(';Natale;'))?.endsWith(';7;7')).toBe(true)
    expect(lines.find((l) => l.includes(';Finita;'))?.endsWith(';5;0')).toBe(true)
  })

  it('skips the patron saint day of the company only', async () => {
    const turin = await scene('06-24')
    const other = await scene(null)
    // 24/06/2030 is a Monday: San Giovanni in Turin.
    for (const s of [turin, other]) {
      await s.browser.call('POST', s.url, { body: body('Tetto', '2030-06-24', '2030-06-28') })
    }
    const read = async (s: typeof turin) =>
      (await s.browser.call('GET', s.companyUrl)).json<{ data: Item[] }>().data[0]
        ?.remaining_working_days
    expect(await read(turin)).toBe(4)
    expect(await read(other)).toBe(5)
  })
})
