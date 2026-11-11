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
  const { company, user } = await fx.companyWithUser(['costs.view', 'costs.create'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const s = {
    browser,
    company,
    site: await one(
      `insert into public.sites (company_id, name, code, cig, cup)
         values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
    ),
    plain: await one(
      "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
    ),
    base: `/api/companies/${company.slug}/costs`,
  }
  for (const [site, amount] of [
    [s.site, '100'],
    [s.plain, '30'],
  ] as const) {
    const created = await browser.call('POST', s.base, {
      body: {
        site_id: site,
        date: '2026-11-04',
        category: 'materials',
        description: 'Calcestruzzo',
        supplier_id: null,
        amount,
        notes: null,
      },
    })
    expect(created.statusCode).toBe(201)
  }
  return s
}

type Scene = Awaited<ReturnType<typeof scene>>

const sites = async (s: Scene, query: string) => {
  const res = await s.browser.call('GET', `${s.base}${query}`)
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { site: { name: string } }[] }>().data.map((d) => d.site.name)
}

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the costs', () => {
  it('carry the codes of the site in the list and in the cost', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}?sort=-amount`)
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { id: string; site: Record<string, unknown> }[] }>().data
    expect(data.map((d) => d.site)).toEqual([
      { id: s.site, name: 'Scuola', code: 'C-1', cig: '12345ABCDE', cup: 'B12C34000560007' },
      { id: s.plain, name: 'Villetta', code: 'C-2', cig: null, cup: null },
    ])
    const one = await s.browser.call('GET', `${s.base}/${data[0]?.id ?? ''}`)
    expect(one.statusCode).toBe(200)
    expect(one.json<{ site: { cig: string } }>().site.cig).toBe('12345ABCDE')
  })

  it('find the costs from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await sites(s, `?filter[q]=${encodeURIComponent(q)}`)).toEqual(['Scuola'])
    }
    // Description and notes are searched as before.
    expect(await sites(s, '?filter[q]=calcestruzzo')).toHaveLength(2)
    const list = await s.browser.call('GET', `${s.base}?filter[q]=12345abcde`)
    expect(list.json<{ meta: { total: number }; total_amount: string }>()).toMatchObject({
      meta: { total: 1 },
      total_amount: '100.00',
    })
  })

  it('end costi.csv with the CIG and CUP columns, following the filter', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export?sort=-amount`)
    expect(res.statusCode).toBe(200)
    const [head, ...rows] = lines(res.body)
    expect(head).toMatch(/;Note;CIG;CUP$/)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^04\/11\/2026;Scuola;.*;12345ABCDE;B12C34000560007$/)
    expect(rows[1]).toMatch(/^04\/11\/2026;Villetta;.*;;$/)
    const filtered = await s.browser.call('GET', `${s.base}/export?filter[q]=B12C34000560007`)
    expect(lines(filtered.body)).toHaveLength(2)
  })

  it('do not find the costs of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ99999' where id = $1`, [s.site])
    expect(await sites(stranger, '?filter[q]=ZZZZZ99999')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.base}?filter[q]=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })
})
