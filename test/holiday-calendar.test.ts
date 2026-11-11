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
  // No permission at all: any member downloads the holidays.
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
  return { browser, company, url: `/api/companies/${company.slug}/holidays/calendar` }
}

function events(ics: string) {
  return ics
    .replace(/\r\n /g, '')
    .split('BEGIN:VEVENT\r\n')
    .slice(1)
    .map((block) => {
      const field = (name: string) =>
        new RegExp(`^${name}[;:](.*)$`, 'm').exec(block)?.[1]?.replace(/\r$/, '') ?? null
      return {
        uid: field('UID'),
        start: field('DTSTART'),
        end: field('DTEND'),
        summary: field('SUMMARY'),
        description: field('DESCRIPTION'),
        alarm: block.includes('BEGIN:VALARM'),
      }
    })
}

describe('holidays calendar', () => {
  it('exports the holidays of the year with the patron saint, to any member', async () => {
    const s = await scene('06-29')
    const res = await s.browser.call('GET', `${s.url}?year=2026`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="festivita-2026.ics"')
    expect(res.body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(res.body).toContain('X-WR-CALNAME:Festività 2026\r\n')
    const list = events(res.body)
    expect(list.map((e) => e.start)).toEqual(
      [
        '0101',
        '0106',
        '0406',
        '0425',
        '0501',
        '0602',
        '0629',
        '0815',
        '1101',
        '1208',
        '1225',
        '1226',
      ].map((md) => `VALUE=DATE:2026${md}`),
    )
    expect(list[2]).toEqual({
      uid: `holiday-${s.company.id}-2026-04-06`,
      start: 'VALUE=DATE:20260406',
      end: 'VALUE=DATE:20260407',
      summary: "Lunedì dell'Angelo",
      description: 'Festività nazionale',
      alarm: false,
    })
    expect(list[6]).toMatchObject({
      summary: 'Santo patrono',
      description: "Santo patrono dell'azienda",
    })
    // An all-day event ends, exclusively, on the day after.
    expect(list[11]).toMatchObject({ summary: 'Santo Stefano', end: 'VALUE=DATE:20261227' })
  })

  it('gives the same events at every export, and moves Easter Monday with the year', async () => {
    const s = await scene(null)
    const first = await s.browser.call('GET', `${s.url}?year=2027`)
    const second = await s.browser.call('GET', `${s.url}?year=2027`)
    expect(second.body).toBe(first.body)
    expect(first.headers['content-disposition']).toBe('attachment; filename="festivita-2027.ics"')
    expect(events(first.body).map((e) => e.start)).toContain('VALUE=DATE:20270329')
  })

  it('uses the current year without the patron saint of another company', async () => {
    const other = await scene('06-29')
    const s = await scene(null)
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const list = events(res.body)
    expect(list).toHaveLength(11)
    expect(list.every((e) => e.description === 'Festività nazionale')).toBe(true)
    // Each company has its own UIDs.
    expect(list.every((e) => e.uid?.startsWith(`holiday-${s.company.id}-`))).toBe(true)
    const theirs = events((await other.browser.call('GET', other.url)).body)
    expect(theirs).toHaveLength(12)
    expect(theirs.some((e) => e.uid?.includes(s.company.id))).toBe(false)
  })

  it('rejects a wrong year', async () => {
    const s = await scene(null)
    for (const year of ['1999', '2101', 'abc', '20260']) {
      expect((await s.browser.call('GET', `${s.url}?year=${year}`)).statusCode).toBe(422)
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
