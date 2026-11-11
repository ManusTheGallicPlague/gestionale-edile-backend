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

const ALL: Permission[] = ['estimates.view']

type Site = { id: string; cig: string | null; cup: string | null } | null

/** Two estimates with an approved SAL: «Scuola» on a public works site, «Villetta» on a plain one. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, params: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  const school = await one(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const house = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  const statement = async (title: string, siteId: string) => {
    const estimate = await one(
      'insert into public.estimates (company_id, title, site_id) values ($1, $2, $3) returning id',
      [title, siteId],
    )
    const chapter = await one(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Opere', 0) returning id`,
      [estimate],
    )
    const item = await one(
      `insert into public.estimate_items (company_id, estimate_id, chapter_id, description,
         unit, unit_price_cents, position) values ($1, $2, $3, 'Voce', 'm²', 10000, 0) returning id`,
      [estimate, chapter],
    )
    const id = await one(
      `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
         status, approved_at, retention_percent)
       values ($1, $2, 1, '2026-10-31', 'approved', now(), '5.00') returning id`,
      [estimate],
    )
    await ctx.owner.query(
      `insert into public.progress_statement_lines (company_id, estimate_id, statement_id,
         item_id, quantity, unit_price_cents) values ($1, $2, $3, $4, '10', 10000)`,
      [company.id, estimate, id, item],
    )
    return `/api/companies/${company.slug}/estimates/${estimate}/progress-statements/${id}`
  }
  return {
    browser,
    company,
    school,
    house,
    schoolSal: await statement('Ampliamento scuola', school),
    houseSal: await statement('Villetta', house),
    list: `/api/companies/${company.slug}/progress-statements`,
  }
}

describe('CIG and CUP of the site in the SAL', () => {
  it('are printed on the PDF of the SAL, and follow the site', async () => {
    const s = await scene()
    const pdf = await s.browser.call('GET', `${s.schoolSal}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.rawPayload.toString('latin1')).toContain('(CIG 12345ABCDE - CUP B12C34000560007)')

    await ctx.owner.query('update public.sites set cig = null where id = $1', [s.school])
    const onlyCup = (await s.browser.call('GET', `${s.schoolSal}/pdf`)).rawPayload.toString(
      'latin1',
    )
    expect(onlyCup).toContain('(CUP B12C34000560007)')
    expect(onlyCup).not.toContain('CIG')
  })

  it('leave the PDF unchanged on a site without them', async () => {
    const s = await scene()
    const pdf = await s.browser.call('GET', `${s.houseSal}/pdf`)
    expect(pdf.statusCode).toBe(200)
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('(Cantiere: Villetta)')
    expect(text).not.toContain('CIG')
    expect(text).not.toContain('CUP')
  })

  it('come with the site in the SAL of the company and can be searched', async () => {
    const s = await scene()
    const list = await s.browser.call('GET', s.list)
    expect(list.statusCode).toBe(200)
    const sites = list.json<{ data: { site: Site }[] }>().data.map((r) => r.site)
    expect(sites).toContainEqual(
      expect.objectContaining({ id: s.school, cig: '12345ABCDE', cup: 'B12C34000560007' }),
    )
    expect(sites).toContainEqual(expect.objectContaining({ id: s.house, cig: null, cup: null }))

    for (const q of ['12345abcde', 'B12C34000560007']) {
      const found = await s.browser.call('GET', `${s.list}?filter[q]=${q}`)
      expect(found.statusCode).toBe(200)
      expect(found.json<{ data: { site: Site }[] }>().data.map((r) => r.site?.id)).toEqual([
        s.school,
      ])
    }
  })

  it('are not found from another company', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query("update public.sites set cig = '99999ZZZZZ' where id = $1", [s.school])
    const found = await stranger.browser.call('GET', `${stranger.list}?filter[q]=99999ZZZZZ`)
    expect(found.statusCode).toBe(200)
    expect(found.json<{ data: unknown[] }>().data).toEqual([])
    const pdf = await stranger.browser.call(
      'GET',
      `${s.schoolSal.replace(s.company.slug, stranger.company.slug)}/pdf`,
    )
    expect(pdf.statusCode).toBe(404)
  })

  it('need estimates.view', async () => {
    const s = await scene([])
    expect((await s.browser.call('GET', `${s.schoolSal}/pdf`)).statusCode).toBe(404)
    expect((await s.browser.call('GET', s.list)).statusCode).toBe(403)
  })
})
