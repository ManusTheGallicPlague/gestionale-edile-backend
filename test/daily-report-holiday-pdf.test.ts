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

const ALL: Permission[] = ['reports.view', 'reports.create', 'reports.update', 'reports.approve']

async function scene(patron: string | null) {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, patron],
    )
  }
  const site = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta') returning id`,
    [company.id],
  )
  const siteId = site.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/daily-reports`
  const report = async (date: string) => {
    const res = await browser.call('POST', base, {
      body: {
        site_id: siteId,
        date,
        weather: null,
        work_done: null,
        notes: null,
        labor: [],
        vehicles: [],
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json<{ id: string }>().id
  }
  const pdf = async (url: string) => {
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    return res.rawPayload.toString('latin1')
  }
  return { browser, base, siteId, report, pdf }
}

describe('holiday in the daily report PDF', () => {
  it('says «festivo» on Sundays, national holidays and the patron saint day only', async () => {
    const s = await scene('12-07')
    const saturday = await s.report('2026-12-05')
    const sunday = await s.report('2026-12-06')
    const patron = await s.report('2026-12-07')
    const immacolata = await s.report('2026-12-08')
    const wednesday = await s.report('2026-12-09')

    const sat = await s.pdf(`${s.base}/${saturday}/pdf`)
    expect(sat).toContain('(Rapportino del 05/12/2026 \\(bozza, non ancora inviato\\))')
    expect(sat).not.toContain('festivo')
    expect(await s.pdf(`${s.base}/${sunday}/pdf`)).toContain(
      '(Rapportino del 06/12/2026, festivo \\(bozza, non ancora inviato\\))',
    )
    expect(await s.pdf(`${s.base}/${patron}/pdf`)).toContain('(Rapportino del 07/12/2026, festivo')
    expect(await s.pdf(`${s.base}/${immacolata}/pdf`)).toContain(
      '(Rapportino del 08/12/2026, festivo',
    )
    const plain = await s.pdf(`${s.base}/${wednesday}/pdf`)
    expect(plain).toContain('(Rapportino del 09/12/2026 \\(bozza')
    expect(plain).not.toContain('festivo')

    // Approved: no «bozza», still «festivo».
    for (const [status, version] of [
      ['submitted', '"1"'],
      ['approved', '"2"'],
    ] as const) {
      const moved = await s.browser.call('POST', `${s.base}/${sunday}/status`, {
        body: { status },
        headers: { 'If-Match': version },
      })
      expect(moved.statusCode).toBe(200)
    }
    expect(await s.pdf(`${s.base}/${sunday}/pdf`)).toContain('(Rapportino del 06/12/2026, festivo)')

    // The work log marks the same days, and only those.
    const log = await s.pdf(
      `${s.base}/pdf?filter[site]=${s.siteId}&filter[from]=2026-12-05&filter[to]=2026-12-09`,
    )
    expect(log.match(/, festivo/g)).toHaveLength(3)
    expect(log).toContain('(Rapportino del 06/12/2026, festivo)')
    expect(log).toContain('(Rapportino del 07/12/2026, festivo \\(bozza')
    expect(log).toContain('(Rapportino del 09/12/2026 \\(bozza')
  })

  it('uses the patron saint day of its own company, not of another one', async () => {
    await scene('12-09')
    const s = await scene(null)
    const wednesday = await s.report('2026-12-09')
    const text = await s.pdf(`${s.base}/${wednesday}/pdf`)
    expect(text).toContain('(Rapportino del 09/12/2026 \\(bozza')
    expect(text).not.toContain('festivo')
  })
})
