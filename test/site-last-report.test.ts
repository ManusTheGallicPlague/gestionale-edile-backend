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

const ALL: Permission[] = ['sites.view', 'sites.create', 'sites.update']

/** Today in Italy, as the backend computes it. */
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())

/** A day relative to today in Italy, as YYYY-MM-DD. */
function day(offset: number) {
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

const italian = (iso: string) => iso.split('-').reverse().join('/')

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/sites` }
}

type Scene = Awaited<ReturnType<typeof scene>>
type SiteBody = { id: string; name: string; last_report_on: string | null }

async function addReport(s: Scene, site: string, offset: number) {
  await ctx.owner.query(
    `insert into public.daily_reports (company_id, site_id, report_date) values ($1, $2, $3)`,
    [s.company.id, site, day(offset)],
  )
}

/** A site with daily reports on the given days (offsets from today). */
async function addSite(s: Scene, name: string, reports: number[] = []) {
  const res = await s.browser.call('POST', s.base, {
    body: {
      code: null,
      name,
      client_id: null,
      address: null,
      status: 'active',
      start_on: null,
      end_on: null,
      budget: null,
      notes: null,
    },
  })
  expect(res.statusCode).toBe(201)
  const id = res.json<SiteBody>().id
  for (const offset of reports) await addReport(s, id, offset)
  return id
}

async function fill(s: Scene) {
  await addSite(s, 'A rapportino oggi', [-30, 0])
  await addSite(s, 'B rapportino 10 giorni fa', [-10, -40])
  await addSite(s, 'C senza rapportini')
  await addSite(s, 'D solo un rapportino domani', [1])
  await addSite(s, 'E rapportino 3 giorni fa e dopodomani', [-3, 2])
}

const pairs = (data: SiteBody[]) => data.map((x) => [x.name, x.last_report_on])

describe('date of the last daily report of a site', () => {
  it('is in the list, the latest up to today, null without reports', async () => {
    const s = await scene()
    await fill(s)
    const res = await s.browser.call('GET', `${s.base}?sort=name`)
    expect(res.statusCode).toBe(200)
    expect(pairs(res.json<{ data: SiteBody[] }>().data)).toEqual([
      ['A rapportino oggi', day(0)],
      ['B rapportino 10 giorni fa', day(-10)],
      ['C senza rapportini', null],
      ['D solo un rapportino domani', null],
      ['E rapportino 3 giorni fa e dopodomani', day(-3)],
    ])
  })

  it('sorts by it: without reports first, then the oldest; and the reverse', async () => {
    const s = await scene()
    await fill(s)
    const asc = await s.browser.call('GET', `${s.base}?sort=last_report_on`)
    expect(asc.statusCode).toBe(200)
    const ascNames = asc.json<{ data: SiteBody[] }>().data.map((x) => x.name)
    expect(ascNames.slice(0, 2).sort()).toEqual([
      'C senza rapportini',
      'D solo un rapportino domani',
    ])
    expect(ascNames.slice(2)).toEqual([
      'B rapportino 10 giorni fa',
      'E rapportino 3 giorni fa e dopodomani',
      'A rapportino oggi',
    ])
    const desc = await s.browser.call('GET', `${s.base}?sort=-last_report_on&per_page=3`)
    expect(desc.statusCode).toBe(200)
    expect(desc.json<{ data: SiteBody[] }>().data.map((x) => x.name)).toEqual([
      'A rapportino oggi',
      'E rapportino 3 giorni fa e dopodomani',
      'B rapportino 10 giorni fa',
    ])
  })

  it('is in the site, follows new reports without changing the ETag, ignored in the body', async () => {
    const s = await scene()
    const id = await addSite(s, 'Scheda', [-5])
    const before = await s.browser.call('GET', `${s.base}/${id}`)
    expect(before.statusCode).toBe(200)
    expect(before.json<SiteBody>().last_report_on).toBe(day(-5))
    await addReport(s, id, -1)
    const after = await s.browser.call('GET', `${s.base}/${id}`)
    expect(after.json<SiteBody>().last_report_on).toBe(day(-1))
    expect(after.headers.etag).toBe(before.headers.etag)
    const updated = await s.browser.call('PUT', `${s.base}/${id}`, {
      body: {
        code: null,
        name: 'Scheda',
        client_id: null,
        address: null,
        status: 'active',
        start_on: null,
        end_on: null,
        budget: null,
        notes: null,
        last_report_on: '2000-01-01',
      },
      headers: { 'if-match': String(after.headers.etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<SiteBody>().last_report_on).toBe(day(-1))
  })

  it('is the last column of the CSV, empty without reports', async () => {
    const s = await scene()
    await fill(s)
    const csv = await s.browser.call('GET', `${s.base}/export?sort=name`)
    expect(csv.statusCode).toBe(200)
    const [header, ...lines] = csv.body.trim().split('\n')
    expect(header?.trim().split(';').at(-1)).toBe('Ultimo rapportino')
    expect(lines.map((l) => l.trim().split(';').at(-1))).toEqual([
      italian(day(0)),
      italian(day(-10)),
      '',
      '',
      italian(day(-3)),
    ])
  })

  it('never counts the reports of another company', async () => {
    const s = await scene()
    const mine = await addSite(s, 'Mio senza rapportini')
    const other = await scene()
    const theirs = await addSite(other, 'Altrui', [0])
    const res = await s.browser.call('GET', `${s.base}/${mine}`)
    expect(res.json<SiteBody>().last_report_on).toBeNull()
    const list = await s.browser.call('GET', s.base)
    expect(pairs(list.json<{ data: SiteBody[] }>().data)).toEqual([['Mio senza rapportini', null]])
    const foreign = await s.browser.call('GET', `${s.base}/${theirs}`)
    expect(foreign.statusCode).toBe(404)
  })
})
