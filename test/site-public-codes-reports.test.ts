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

const ALL: Permission[] = ['reports.view', 'reports.create']

/** A public works site «Scuola» and a plain site «Villetta», with a daily report each. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string, params: unknown[]) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  const site = (name: string, code: string, cig: string | null, cup: string | null) =>
    insert(
      `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, $2, $3, $4, $5) returning id`,
      [name, code, cig, cup],
    )
  const school = await site('Scuola', 'C-1', '12345ABCDE', 'B12C34000560007')
  const house = await site('Villetta', 'C-2', null, null)
  const report = (siteId: string) =>
    insert(
      `insert into public.daily_reports (company_id, site_id, report_date)
       values ($1, $2, '2026-11-05') returning id`,
      [siteId],
    )
  const base = `/api/companies/${company.slug}/daily-reports`
  return {
    browser,
    base,
    school,
    house,
    schoolReport: await report(school),
    houseReport: await report(house),
    pdf: async (url: string) => {
      const res = await browser.call('GET', url)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('application/pdf')
      return res.rawPayload.toString('latin1')
    },
  }
}

const workLog = (siteId: string) =>
  `pdf?filter[site]=${siteId}&filter[from]=2026-11-01&filter[to]=2026-11-30`

describe('CIG and CUP of the site in the daily report and the work log', () => {
  it('are printed on the PDF of the daily report, and follow the site', async () => {
    const s = await scene()
    const url = `${s.base}/${s.schoolReport}/pdf`
    expect(await s.pdf(url)).toContain('(CIG 12345ABCDE - CUP B12C34000560007)')

    await ctx.owner.query('update public.sites set cig = null where id = $1', [s.school])
    const onlyCup = await s.pdf(url)
    expect(onlyCup).toContain('(CUP B12C34000560007)')
    expect(onlyCup).not.toContain('CIG')

    await ctx.owner.query('update public.sites set cig = $2, cup = null where id = $1', [
      s.school,
      '12345ABCDE',
    ])
    const onlyCig = await s.pdf(url)
    expect(onlyCig).toContain('(CIG 12345ABCDE)')
    expect(onlyCig).not.toContain('CUP')
  })

  it('are not printed for a site without codes', async () => {
    const s = await scene()
    const pdf = await s.pdf(`${s.base}/${s.houseReport}/pdf`)
    expect(pdf).toContain('(Cantiere: C-2 ')
    expect(pdf).not.toContain('CIG')
    expect(pdf).not.toContain('CUP')
  })

  it('are printed on every report of the work log', async () => {
    const s = await scene()
    await ctx.owner.query(
      `insert into public.daily_reports (company_id, site_id, report_date)
       select company_id, id, '2026-11-06' from public.sites where id = $1`,
      [s.school],
    )
    const log = await s.pdf(`${s.base}/${workLog(s.school)}`)
    expect(log.split('(CIG 12345ABCDE - CUP B12C34000560007)').length - 1).toBe(2)

    const plain = await s.pdf(`${s.base}/${workLog(s.house)}`)
    expect(plain).not.toContain('CIG')
    expect(plain).not.toContain('CUP')
  })

  it('stay out of reach of another company and without reports.view', async () => {
    const s = await scene()
    const other = await scene()
    expect((await other.browser.call('GET', `${s.base}/${s.schoolReport}/pdf`)).statusCode).toBe(
      404,
    )
    expect((await other.browser.call('GET', `${other.base}/${workLog(s.school)}`)).statusCode).toBe(
      404,
    )

    const blind = await scene(['reports.create'])
    expect(
      (await blind.browser.call('GET', `${blind.base}/${blind.schoolReport}/pdf`)).statusCode,
    ).toBe(404)
    expect(
      (await blind.browser.call('GET', `${blind.base}/${workLog(blind.school)}`)).statusCode,
    ).toBe(403)
  })
})
