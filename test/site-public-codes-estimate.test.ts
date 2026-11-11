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

/** An estimate on a public works site «Scuola» and one on a plain site «Villetta». */
async function scene(permissions: Permission[] = ['estimates.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string, params: unknown[]) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  const site = (name: string, cig: string | null, cup: string | null) =>
    insert(
      `insert into public.sites (company_id, name, cig, cup) values ($1, $2, $3, $4) returning id`,
      [name, cig, cup],
    )
  const school = await site('Scuola', '12345ABCDE', 'B12C34000560007')
  const house = await site('Villetta', null, null)
  const estimate = async (title: string, siteId: string | null) =>
    `/api/companies/${company.slug}/estimates/${await insert(
      'insert into public.estimates (company_id, title, site_id) values ($1, $2, $3) returning id',
      [title, siteId],
    )}/pdf`
  return {
    browser,
    school,
    schoolPdf: await estimate('Ampliamento scuola', school),
    housePdf: await estimate('Villetta', house),
    loosePdf: await estimate('Senza cantiere', null),
    pdf: async (url: string) => {
      const res = await browser.call('GET', url)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('application/pdf')
      return res.rawPayload.toString('latin1')
    },
  }
}

describe('CIG and CUP of the site in the estimate PDF', () => {
  it('are printed under the site, and follow the site', async () => {
    const s = await scene()
    expect(await s.pdf(s.schoolPdf)).toContain('(CIG 12345ABCDE - CUP B12C34000560007)')

    await ctx.owner.query('update public.sites set cup = null where id = $1', [s.school])
    const onlyCig = await s.pdf(s.schoolPdf)
    expect(onlyCig).toContain('(CIG 12345ABCDE)')
    expect(onlyCig).not.toContain('CUP')
  })

  it('are not printed for a site without codes or an estimate without site', async () => {
    const s = await scene()
    for (const url of [s.housePdf, s.loosePdf]) {
      const pdf = await s.pdf(url)
      expect(pdf).not.toContain('CIG')
      expect(pdf).not.toContain('CUP')
    }
  })

  it('stay out of reach of another company and without estimates.view', async () => {
    const s = await scene()
    const other = await scene()
    expect((await other.browser.call('GET', s.schoolPdf)).statusCode).toBe(404)
    const blind = await scene(['estimates.create'])
    expect((await blind.browser.call('GET', blind.schoolPdf)).statusCode).toBe(404)
  })
})
