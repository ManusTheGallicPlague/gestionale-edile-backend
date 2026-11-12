import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('permit and people of the site in the SAL', () => {
  it('are printed on the PDF of the SAL only when set, and follow the site', async () => {
    const { company, user } = await fx.companyWithUser(['estimates.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const one = async (sql: string, params: unknown[] = []) =>
      (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
    const site = await one(
      `insert into public.sites (company_id, name, code, permit, works_director, safety_coordinator)
       values ($1, 'Condominio', 'C-1', 'Permesso di costruire n. 12/2026', 'Ing. Carla Blu',
         'Geom. Luca Neri') returning id`,
    )
    const estimate = await one(
      `insert into public.estimates (company_id, title, site_id)
       values ($1, 'Facciata', $2) returning id`,
      [site],
    )
    const id = await one(
      `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
         status, approved_at) values ($1, $2, 1, '2026-10-31', 'approved', now()) returning id`,
      [estimate],
    )
    const url = `/api/companies/${company.slug}/estimates/${estimate}/progress-statements/${id}/pdf`
    const pdf = async () => {
      const res = await browser.call('GET', url)
      expect(res.statusCode).toBe(200)
      return res.rawPayload.toString('latin1')
    }
    const full = await pdf()
    expect(full).toContain('(Titolo edilizio: Permesso di costruire n. 12/2026)')
    expect(full).toContain('(Direttore dei lavori: Ing. Carla Blu)')
    expect(full).toContain('(Coordinatore sicurezza: Geom. Luca Neri)')

    await ctx.owner.query(
      'update public.sites set permit = null, works_director = null where id = $1',
      [site],
    )
    const partial = await pdf()
    expect(partial).not.toContain('Titolo edilizio')
    expect(partial).not.toContain('Direttore dei lavori:')
    expect(partial).toContain('(Coordinatore sicurezza: Geom. Luca Neri)')
  })
})
