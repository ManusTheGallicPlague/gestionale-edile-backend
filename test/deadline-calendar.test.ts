import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { escapeText, foldLine } from '../src/deadlines/ical.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

/** Unfolds the lines as a calendar would. */
const unfold = (body: string) => body.replace(/\r\n /g, '').split('\r\n')

describe('icalendar', () => {
  it('escapes text and folds long lines at 75 octets without splitting characters', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne')
    const line = `SUMMARY:${'è'.repeat(60)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    expect(Buffer.byteLength(parts[0] ?? '', 'utf8')).toBeLessThanOrEqual(75)
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true)
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
    expect(foldLine('SHORT:1')).toBe('SHORT:1')
  })
})

describe('deadlines calendar', () => {
  it('exports open deadlines as all-day events, only for the company', async () => {
    const { company, user } = await fx.companyWithUser(['deadlines.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const site = await ctx.owner.query<{ id: string }>(
      `insert into public.sites (company_id, code, name) values ($1, 'C1', 'Villa; Rossi')
       returning id`,
      [company.id],
    )
    const inserted = await ctx.owner.query<{ id: string }>(
      `insert into public.deadlines
         (company_id, title, due_on, kind, amount_cents, recurrence, site_id, notes, status, done_at)
       values ($1, 'F24 IVA', '2026-12-31', 'tax', 123450, 'monthly', $2, E'Riga uno\\nriga, due', 'open', null),
              ($1, 'Revisione furgone', '2026-11-30', 'vehicle', null, null, null, null, 'open', null),
              ($1, 'DURC vecchio', '2026-10-01', 'durc', null, null, null, null, 'done', now())
       returning id`,
      [company.id, site.rows[0]?.id],
    )
    const other = await fx.company()
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind)
       values ($1, 'Scadenza altrui', '2026-11-01', 'other')`,
      [other.id],
    )

    const url = `/api/companies/${company.slug}/deadlines/calendar`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="scadenze.ics"')
    expect(res.body.endsWith('\r\n')).toBe(true)
    for (const raw of res.body.split('\r\n')) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75)
    }
    const lines = unfold(res.body)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2)
    expect(res.body).not.toContain('altrui')
    expect(res.body).not.toContain('DURC vecchio')

    // Ordered by date: the van first.
    const summaries = lines.filter((l) => l.startsWith('SUMMARY:'))
    expect(summaries).toEqual(['SUMMARY:Revisione furgone', 'SUMMARY:F24 IVA'])
    // The last day of the year ends on the first of the next one.
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231')
    expect(lines).toContain('DTEND;VALUE=DATE:20270101')
    expect(lines).toContain(`UID:deadline-${inserted.rows[0]?.id}`)
    expect(lines).toContain('TRIGGER:-PT15H')
    expect(lines).toContain(
      'DESCRIPTION:Tipo: Imposte\\nImporto: € 1234\\,50\\nCantiere: Villa\\; Rossi\\nRicorrenza: Mensile\\n\\nRiga uno\\nriga\\, due',
    )
    expect(lines.some((l) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(l))).toBe(true)

    // Same UIDs every time, so the calendar updates instead of duplicating.
    const again = await browser.call('GET', url)
    const uids = (body: string) => unfold(body).filter((l) => l.startsWith('UID:'))
    expect(uids(again.body)).toEqual(uids(res.body))

    const done = await browser.call('GET', `${url}?filter[status]=done`)
    expect(unfold(done.body).filter((l) => l.startsWith('SUMMARY:'))).toEqual([
      'SUMMARY:Fatta: DURC vecchio',
    ])
    const ranged = await browser.call('GET', `${url}?filter[from]=2026-12-01&search=f24`)
    expect(unfold(ranged.body).filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1)

    const empty = await browser.call('GET', `${url}?filter[kind]=insurance`)
    expect(empty.statusCode).toBe(200)
    expect(empty.body).not.toContain('BEGIN:VEVENT')
    expect(empty.body).toContain('END:VCALENDAR')

    const invalid = await browser.call('GET', `${url}?filter[from]=31/12/2026`)
    expect(invalid.statusCode).toBe(422)
  })

  it('refuses without permission, another company and without session', async () => {
    const { company } = await fx.companyWithUser(['deadlines.view'])
    const url = `/api/companies/${company.slug}/deadlines/calendar`

    const blind = await fx.companyWithUser(['clients.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const denied = await b.call('GET', `/api/companies/${blind.company.slug}/deadlines/calendar`)
    expect(denied.statusCode).toBe(403)
    expect((await b.call('GET', url)).statusCode).toBe(404)

    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', url)).statusCode).toBe(401)
  })
})
