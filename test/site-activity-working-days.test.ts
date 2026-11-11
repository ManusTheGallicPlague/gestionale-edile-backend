import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function scene(patron: string | null) {
  const { company, user } = await fx.companyWithUser(['sites.view', 'sites.update'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name, status) values ($1, 'Villetta', 'active') returning id",
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
    company,
    url: `/api/companies/${company.slug}/sites/${site.rows[0]?.id ?? ''}/activities`,
    companyUrl: `/api/companies/${company.slug}/activities`,
  }
}

const body = (name: string, start_on: string, end_on: string) => ({
  name,
  start_on,
  end_on,
  progress: 0,
  depends_on: [],
  notes: null,
})

interface Activity {
  id: string
  name: string
  working_days: number
}

describe('working days of the schedule activities', () => {
  it('counts Monday to Friday without national holidays', async () => {
    const s = await scene(null)
    // 7-11/12/2026: five weekdays, 8/12 is the Immacolata.
    const week = await s.browser.call('POST', s.url, {
      body: body('Intonaci', '2026-12-07', '2026-12-11'),
    })
    expect(week.statusCode).toBe(201)
    expect(week.json<Activity>().working_days).toBe(4)
    // 21/12/2026-08/01/2027: 15 weekdays without Christmas, New Year and Epiphany.
    await s.browser.call('POST', s.url, { body: body('Pavimenti', '2026-12-21', '2027-01-08') })
    // A Saturday only.
    await s.browser.call('POST', s.url, { body: body('Pulizie', '2026-12-12', '2026-12-12') })
    // Easter Monday 2027 is 29/03.
    await s.browser.call('POST', s.url, { body: body('Tetto', '2027-03-29', '2027-04-02') })

    const list = await s.browser.call('GET', s.url)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Activity[] }>().data.map((a) => [a.name, a.working_days])).toEqual([
      ['Intonaci', 4],
      ['Pulizie', 0],
      ['Pavimenti', 12],
      ['Tetto', 4],
    ])

    const one = week.json<Activity>()
    const moved = await s.browser.call('PUT', `${s.url}/${one.id}`, {
      body: body('Intonaci', '2026-12-14', '2026-12-18'),
      headers: { 'if-match': '"1"' },
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json<Activity>().working_days).toBe(5)
  })

  it('skips the patron saint of the company, in the company list and the CSV too', async () => {
    const s = await scene('12-07')
    const other = await scene('12-09')
    await other.browser.call('POST', other.url, {
      body: body('Intonaci', '2026-12-07', '2026-12-11'),
    })
    const created = await s.browser.call('POST', s.url, {
      body: body('Intonaci', '2026-12-07', '2026-12-11'),
    })
    expect(created.json<Activity>().working_days).toBe(3)
    // The patron saint on a Sunday (13/12/2026) changes nothing.
    const sunday = await scene('12-13')
    const onSunday = await sunday.browser.call('POST', sunday.url, {
      body: body('Intonaci', '2026-12-07', '2026-12-18'),
    })
    expect(onSunday.json<Activity>().working_days).toBe(9)

    const list = await s.browser.call('GET', s.companyUrl)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Activity[] }>().data.map((a) => a.working_days)).toEqual([3])
    const otherList = await other.browser.call('GET', other.companyUrl)
    expect(otherList.json<{ data: Activity[] }>().data.map((a) => a.working_days)).toEqual([3])

    const csv = await s.browser.call('GET', `${s.companyUrl}/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('﻿', '').split('\r\n')).toEqual([
      'Cantiere;Codice cantiere;Attività;Inizio;Fine;Avanzamento %;Giorni di ritardo;Note;Giorni lavorativi',
      'Villetta;;Intonaci;07/12/2026;11/12/2026;0;0;;3',
      '',
    ])
  })
})
