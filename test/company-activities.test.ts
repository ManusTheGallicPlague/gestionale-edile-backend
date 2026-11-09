import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface ListedActivity {
  name: string
  progress: number
  days_late: number
  site: { id: string; name: string; code: string | null; status: string }
}

/** A company with activities in every situation, and a user with the given permissions. */
async function scene(permissions: Permission[] = ['sites.view']) {
  const { company } = await fx.companyWithUser(['sites.view'])
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Cronoprogramma', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = async (name: string, status: string) => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.sites (company_id, name, code, status) values ($1, $2, $3, $4)
       returning id`,
      [company.id, name, `C-${status}`, status],
    )
    return rows[0]?.id ?? ''
  }
  /** An activity from `start` to `end` days from today (Italian date). */
  const activity = (siteId: string, name: string, start: number, end: number, progress: number) =>
    ctx.owner.query(
      `insert into public.site_activities (company_id, site_id, name, start_on, end_on, progress)
       values ($1, $2, $3, (now() at time zone 'Europe/Rome')::date + $4::int,
         (now() at time zone 'Europe/Rome')::date + $5::int, $6)`,
      [company.id, siteId, name, start, end, progress],
    )
  const active = await site('Via Roma', 'active')
  const planned = await site('Via Milano', 'planned')
  const suspended = await site('Via Torino', 'suspended')
  const completed = await site('Via Napoli', 'completed')
  await activity(active, 'Scavi', -20, -5, 60) // Late by 5 days.
  await activity(active, 'Fondazioni', -10, -1, 99) // Late by 1 day.
  await activity(active, 'Demolizioni', -30, -10, 100) // Finished: not late.
  await activity(active, 'Murature', -2, 3, 20) // In progress.
  await activity(active, 'Ponteggi', 0, 0, 100) // Today but finished: not in progress.
  await activity(planned, 'Impianti', 0, 4, 0) // Starts today: soon and in progress.
  await activity(planned, 'Intonaci', 7, 9, 0) // Starts in 7 days: soon.
  await activity(planned, 'Pavimenti', 8, 12, 0) // Starts in 8 days: not yet.
  await activity(planned, 'Serramenti', 2, 5, 10) // Already started by hand: not soon.
  await activity(suspended, 'Tetto', -10, -3, 10) // Late, but the site is suspended.
  await activity(completed, 'Pulizie', -10, -3, 10) // Late, but the site is closed.
  return { browser, company, active, url: `/api/companies/${company.slug}/activities` }
}

const names = (body: { data: ListedActivity[] }) => body.data.map((a) => a.name)

describe('schedule activities of the whole company', () => {
  it('lists every activity by end date, with the site and the days late', async () => {
    const s = await scene()
    await scene() // Another company with the same activities.
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: ListedActivity[]; meta: unknown }>()
    expect(body.meta).toEqual({ total: 11, page: 1, per_page: 25 })
    expect(names(body)).toEqual([
      'Demolizioni',
      'Scavi',
      'Pulizie',
      'Tetto',
      'Fondazioni',
      'Ponteggi',
      'Murature',
      'Impianti',
      'Serramenti',
      'Intonaci',
      'Pavimenti',
    ])
    const scavi = body.data[1]
    expect(scavi?.days_late).toBe(5)
    expect(scavi?.site).toEqual({
      id: s.active,
      name: 'Via Roma',
      code: 'C-active',
      status: 'active',
    })
    expect(body.data[0]?.days_late).toBe(0) // Finished.
    expect(body.data[2]?.days_late).toBe(3) // The list shows it even on a closed site.
    expect(body.data[6]?.days_late).toBe(0) // Not yet due.
  })

  it('filters the activities to follow up and the site, and pages', async () => {
    const s = await scene()
    const get = async (query: string) => {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: ListedActivity[]; meta: { total: number } }>()
    }
    expect(names(await get('filter[follow_up]=late'))).toEqual(['Scavi', 'Fondazioni'])
    expect(names(await get('filter[follow_up]=starting_soon'))).toEqual(['Impianti', 'Intonaci'])
    expect(names(await get('filter[follow_up]=in_progress'))).toEqual(['Murature', 'Impianti'])
    expect(names(await get(`filter[site]=${s.active}&filter[follow_up]=late`))).toEqual([
      'Scavi',
      'Fondazioni',
    ])
    expect((await get(`filter[site]=${s.active}`)).meta.total).toBe(5)
    const page = await get('per_page=2&page=2')
    expect(names(page)).toEqual(['Pulizie', 'Tetto'])
    expect(page.meta).toEqual({ total: 11, page: 2, per_page: 2 })
  })

  it('filters the activities that touch a period, in the list and in the CSV', async () => {
    const s = await scene()
    const { rows } = await ctx.owner.query<{ day: string }>(
      `select ((now() at time zone 'Europe/Rome')::date + t.n)::text as day
       from unnest($1::int[]) with ordinality as t(n, i) order by i`,
      [[-5, -1, 0, 4, 7, 9]],
    )
    const day = (offset: number) => rows[[-5, -1, 0, 4, 7, 9].indexOf(offset)]?.day ?? 'missing'
    const get = async (query: string) => {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: ListedActivity[]; meta: { total: number } }>()
    }
    // Today only: what runs today, ends today or starts today (extremes included).
    expect(names(await get(`filter[from]=${day(0)}&filter[to]=${day(0)}`))).toEqual([
      'Ponteggi',
      'Murature',
      'Impianti',
    ])
    // From 7 to 9 days ahead: Intonaci starts on the 7th, Pavimenti on the 8th.
    expect(names(await get(`filter[from]=${day(7)}&filter[to]=${day(9)}`))).toEqual([
      'Intonaci',
      'Pavimenti',
    ])
    // Only the start: everything still running from 4 days ahead.
    expect(names(await get(`filter[from]=${day(4)}`))).toEqual([
      'Impianti',
      'Serramenti',
      'Intonaci',
      'Pavimenti',
    ])
    // Only the end: what started by 5 days ago, together with the site filter.
    expect(names(await get(`filter[to]=${day(-5)}&filter[site]=${s.active}`))).toEqual([
      'Demolizioni',
      'Scavi',
      'Fondazioni',
    ])
    expect((await get(`filter[from]=${day(-1)}&filter[to]=${day(-1)}`)).meta.total).toBe(2)
    const csv = await s.browser.call(
      'GET',
      `${s.url}/export?filter[from]=${day(7)}&filter[to]=${day(9)}`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('\ufeff', '').trim().split('\r\n')).toHaveLength(3)
    for (const [query, field] of [
      ['filter[from]=31/12/2026', 'filter[from]'],
      ['filter[to]=domani', 'filter[to]'],
      [`filter[from]=${day(4)}&filter[to]=${day(0)}`, 'filter[to]'],
      [`filter[from]=${day(0)}&filter[from]=${day(4)}`, 'filter[from]'],
    ] as const) {
      for (const url of [s.url, `${s.url}/export`]) {
        const res = await s.browser.call('GET', `${url}?${query}`)
        expect(res.statusCode).toBe(422)
        expect(res.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty([field])
      }
    }
  })

  it('searches the name and notes of the activity and the name and code of the site', async () => {
    const s = await scene()
    await scene() // Another company with the same activities and sites.
    await ctx.owner.query(
      `update public.site_activities set notes = 'Attesa del permesso del Comune'
       where company_id = $1 and name = 'Tetto'`,
      [s.company.id],
    )
    const get = async (query: string) => {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: ListedActivity[]; meta: { total: number } }>()
    }
    expect(names(await get('filter[q]=scavi'))).toEqual(['Scavi'])
    expect(names(await get('filter[q]=%20%20MURA%20'))).toEqual(['Murature'])
    expect(names(await get('filter[q]=comune'))).toEqual(['Tetto'])
    const planned = ['Impianti', 'Serramenti', 'Intonaci', 'Pavimenti']
    expect(names(await get('filter[q]=via%20milano'))).toEqual(planned)
    expect(names(await get('filter[q]=c-planned'))).toEqual(planned)
    // Together with the other filters: the late activities of Via Roma.
    expect(names(await get('filter[q]=roma&filter[follow_up]=late'))).toEqual([
      'Scavi',
      'Fondazioni',
    ])
    // No wildcards: % and _ are plain text.
    expect((await get('filter[q]=%25')).meta.total).toBe(0)
    expect((await get('filter[q]=via_')).meta.total).toBe(0)
    // Only spaces: no filter at all, and the total counts the filter, not the page.
    expect((await get('filter[q]=%20%20')).meta.total).toBe(11)
    expect(await get('filter[q]=via&per_page=2&page=2')).toMatchObject({
      meta: { total: 11, page: 2, per_page: 2 },
    })
    const csv = await s.browser.call('GET', `${s.url}/export?filter[q]=MILANO`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toHaveLength(5)
    for (const query of [`filter[q]=${'a'.repeat(101)}`, 'filter[q]=scavi&filter[q]=tetto']) {
      for (const url of [s.url, `${s.url}/export`]) {
        const res = await s.browser.call('GET', `${url}?${query}`)
        expect(res.statusCode).toBe(422)
        expect(res.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty(['filter[q]'])
      }
    }
  })

  it('does not show the activities of a site of another company', async () => {
    const s = await scene()
    const other = await scene()
    const res = await s.browser.call('GET', `${s.url}?filter[site]=${other.active}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: unknown[]; meta: { total: number } }>()).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25 },
    })
    const foreign = await s.browser.call('GET', `/api/companies/${other.company.slug}/activities`)
    expect(foreign.statusCode).toBe(404)
  })

  it('rejects wrong filters with 422', async () => {
    const s = await scene()
    for (const [query, field] of [
      ['filter[follow_up]=overdue', 'filter[follow_up]'],
      ['filter[site]=abc', 'filter[site]'],
      ['filter[follow_up]=late&filter[follow_up]=late', 'filter[follow_up]'],
      ['per_page=101', 'per_page'],
      ['page=0', 'page'],
    ] as const) {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty([field])
    }
  })

  it('answers 403 without sites.view and 401 without a session', async () => {
    const s = await scene(['reports.view'])
    expect((await s.browser.call('GET', s.url)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', s.url)).statusCode).toBe(401)
  })
})

describe('schedule activities in the dashboard', () => {
  it('counts the late and starting activities, only of the company', async () => {
    const s = await scene()
    await scene()
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ activities: unknown }>().activities).toEqual({ late: 2, starting_soon: 2 })
  })

  it('is null without sites.view, and zero for a company without activities', async () => {
    const blind = await scene(['reports.view'])
    const res = await blind.browser.call('GET', `/api/companies/${blind.company.slug}/dashboard`)
    expect(res.json<{ activities: unknown }>().activities).toBeNull()
    const { company } = await fx.companyWithUser(['sites.view'])
    const user = await fx.user()
    await fx.member(user.id, company.id, await fx.role(company.id, 'Vuota', ['sites.view']))
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const empty = await browser.call('GET', `/api/companies/${company.slug}/dashboard`)
    expect(empty.json<{ activities: unknown }>().activities).toEqual({ late: 0, starting_soon: 0 })
  })
})

describe('schedule activities in CSV', () => {
  it('exports the filtered activities with Italian dates and the days late', async () => {
    const s = await scene()
    await scene()
    await ctx.owner.query(
      "update public.site_activities set notes = '=SOMMA(A1); da sollecitare' where name = 'Scavi' and company_id = $1",
      [s.company.id],
    )
    const res = await s.browser.call('GET', `${s.url}/export?filter[follow_up]=late`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="cronoprogramma.csv"')
    const { rows } = await ctx.owner.query<{ s: string; e: string; f: string }>(
      `select to_char(d - 20, 'DD/MM/YYYY') as s, to_char(d - 5, 'DD/MM/YYYY') as e,
         to_char(d - 1, 'DD/MM/YYYY') as f
       from (select (now() at time zone 'Europe/Rome')::date as d) x`,
    )
    const r = rows[0]
    const fondazioniStart = await ctx.owner.query<{ v: string }>(
      "select to_char((now() at time zone 'Europe/Rome')::date - 10, 'DD/MM/YYYY') as v",
    )
    expect(res.body.replace('﻿', '').split('\r\n')).toEqual([
      'Cantiere;Codice cantiere;Attività;Inizio;Fine;Avanzamento %;Giorni di ritardo;Note',
      `Via Roma;C-active;Scavi;${r?.s};${r?.e};60;5;"'=SOMMA(A1); da sollecitare"`,
      `Via Roma;C-active;Fondazioni;${fondazioniStart.rows[0]?.v};${r?.f};99;1;`,
      '',
    ])
    const all = await s.browser.call('GET', `${s.url}/export`)
    expect(all.body.replace('﻿', '').trim().split('\r\n')).toHaveLength(12)
  })

  it('rejects wrong filters, and answers 403 without sites.view and 401 without a session', async () => {
    const s = await scene()
    const wrong = await s.browser.call('GET', `${s.url}/export?filter[follow_up]=overdue`)
    expect(wrong.statusCode).toBe(422)
    const blind = await scene(['reports.view'])
    expect((await blind.browser.call('GET', `${blind.url}/export`)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', `${s.url}/export`)).statusCode).toBe(401)
  })
})
