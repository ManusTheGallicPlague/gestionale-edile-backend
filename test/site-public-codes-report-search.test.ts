import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function scene() {
  const { company, user } = await fx.companyWithUser(['reports.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, values: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...values])).rows[0]?.id ?? ''
  const site = await one(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const plain = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  for (const s of [site, plain]) {
    await one(
      `insert into public.daily_reports (company_id, site_id, report_date, work_done)
         values ($1, $2, '2026-11-04', 'Getto del solaio') returning id`,
      [s],
    )
  }
  return { browser, company, site, base: `/api/companies/${company.slug}/daily-reports` }
}

type Scene = Awaited<ReturnType<typeof scene>>

const sites = async (s: Scene, q: string) => {
  const res = await s.browser.call('GET', `${s.base}?filter[q]=${encodeURIComponent(q)}`)
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { site: { name: string } }[] }>().data.map((d) => d.site.name)
}

describe('CIG and CUP of the site in the search of the daily reports', () => {
  it('find the reports from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await sites(s, q)).toEqual(['Scuola'])
    }
    // Work done and notes are searched as before.
    expect(await sites(s, 'solaio')).toHaveLength(2)
    const list = await s.browser.call('GET', `${s.base}?filter[q]=12345abcde`)
    expect(list.json<{ meta: { total: number } }>().meta.total).toBe(1)
  })

  it('apply the same search to rapportini.csv', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export?filter[q]=B12C34000560007`)
    expect(res.statusCode).toBe(200)
    const rows = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Scuola')
  })

  it('do not find the reports of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ99999' where id = $1`, [s.site])
    expect(await sites(stranger, 'ZZZZZ99999')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.base}?filter[q]=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })

  it('need reports.view', async () => {
    const s = await scene()
    const { company, user } = await fx.companyWithUser(['sites.view'])
    const blind = new Browser(ctx.app)
    await blind.signIn(user.email)
    const res = await blind.call('GET', `/api/companies/${company.slug}/daily-reports?filter[q]=1`)
    expect(res.statusCode).toBe(403)
    expect((await blind.call('GET', `${s.base}?filter[q]=1`)).statusCode).toBe(404)
  })
})
