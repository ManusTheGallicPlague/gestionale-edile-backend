import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('permit and people of the site in the daily report and the work log', () => {
  it('are printed only when set, and follow the site', async () => {
    const { company, user } = await fx.companyWithUser(['reports.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const insert = async (sql: string, params: unknown[]) =>
      (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
    const site = await insert(
      `insert into public.sites (company_id, name, code, permit, works_director, safety_coordinator)
       values ($1, 'Condominio', 'C-1', 'SCIA n. 7/2026', 'Arch. Paola Verdi', 'Geom. Luca Neri')
       returning id`,
      [],
    )
    const report = await insert(
      `insert into public.daily_reports (company_id, site_id, report_date)
       values ($1, $2, '2026-11-05') returning id`,
      [site],
    )
    const base = `/api/companies/${company.slug}/daily-reports`
    const pdf = async (url: string) => {
      const res = await browser.call('GET', url)
      expect(res.statusCode).toBe(200)
      return res.rawPayload.toString('latin1')
    }
    const urls = [
      `${base}/${report}/pdf`,
      `${base}/pdf?filter[site]=${site}&filter[from]=2026-11-01&filter[to]=2026-11-30`,
    ]
    for (const url of urls) {
      const text = await pdf(url)
      expect(text).toContain('(Titolo edilizio: SCIA n. 7/2026)')
      expect(text).toContain('(Direttore dei lavori: Arch. Paola Verdi)')
      expect(text).toContain('(Coordinatore sicurezza: Geom. Luca Neri)')
    }

    await ctx.owner.query(
      'update public.sites set permit = null, safety_coordinator = null where id = $1',
      [site],
    )
    for (const url of urls) {
      const text = await pdf(url)
      expect(text).not.toContain('Titolo edilizio')
      expect(text).not.toContain('Coordinatore sicurezza')
      expect(text).toContain('(Direttore dei lavori: Arch. Paola Verdi)')
    }

    // Another company cannot print them.
    const stranger = await fx.companyWithUser(['reports.view'])
    const other = new Browser(ctx.app)
    await other.signIn(stranger.user.email)
    const hidden = await other.call(
      'GET',
      `/api/companies/${stranger.company.slug}/daily-reports/${report}/pdf`,
    )
    expect(hidden.statusCode).toBe(404)
  })
})
