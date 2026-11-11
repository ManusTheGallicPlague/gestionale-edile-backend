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
  const { company, user } = await fx.companyWithUser(['costs.view', 'sites.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, code, cig, cup, budget_cents) values
       ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007', 10000),
       ($1, 'Strada', 'C-2', null, 'J98K76000120003', null),
       ($1, 'Villetta', 'C-3', null, null, null)
     returning id`,
    [company.id],
  )
  await ctx.owner.query(
    `insert into public.site_costs (company_id, site_id, cost_date, category, description, amount_cents)
     values ($1, $2, '2026-11-04', 'materials', 'Calcestruzzo', 12000)`,
    [company.id, sites.rows[0]?.id],
  )
  return {
    browser,
    company,
    ids: sites.rows.map((r) => r.id),
    base: `/api/companies/${company.slug}/site-costs/totals`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const names = async (s: Scene, query: string) => {
  const res = await s.browser.call('GET', `${s.base}${query}`)
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { site: { name: string } }[] }>().data.map((d) => d.site.name)
}

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the costs of every site', () => {
  it('carry the codes of each site', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.base)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { site: unknown }[] }>().data.map((d) => d.site)).toEqual([
      {
        id: s.ids[0],
        name: 'Scuola',
        code: 'C-1',
        cig: '12345ABCDE',
        cup: 'B12C34000560007',
        status: 'planned',
      },
      {
        id: s.ids[1],
        name: 'Strada',
        code: 'C-2',
        cig: null,
        cup: 'J98K76000120003',
        status: 'planned',
      },
      { id: s.ids[2], name: 'Villetta', code: 'C-3', cig: null, cup: null, status: 'planned' },
    ])
  })

  it('find the sites from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await names(s, `?search=${encodeURIComponent(q)}`)).toEqual(['Scuola'])
    }
    expect(await names(s, '?search=j98k')).toEqual(['Strada'])
    // Name and code are searched as before; a space between CIG and CUP finds nothing.
    expect(await names(s, '?search=vill')).toEqual(['Villetta'])
    expect(await names(s, '?search=C-2')).toEqual(['Strada'])
    expect(await names(s, `?search=${encodeURIComponent('ABCDE B12C')}`)).toEqual([])
    const res = await s.browser.call('GET', `${s.base}?search=12345abcde`)
    expect(
      res.json<{ meta: { total: number }; total_amount: string; budget_amount: string }>(),
    ).toMatchObject({ meta: { total: 1 }, total_amount: '120.00', budget_amount: '100.00' })
  })

  it('put the CIG and CUP columns in costi-cantieri.csv, before the period', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export`)
    expect(res.statusCode).toBe(200)
    const [head, ...rows] = lines(res.body)
    expect(head).toMatch(/;Sopra budget;CIG;CUP$/)
    expect(rows).toEqual([
      'Scuola;C-1;Da iniziare;0,00;0,00;120,00;120,00;100,00;-20,00;Sì;12345ABCDE;B12C34000560007',
      'Strada;C-2;Da iniziare;0,00;0,00;0,00;0,00;;;No;;J98K76000120003',
      'Villetta;C-3;Da iniziare;0,00;0,00;0,00;0,00;;;No;;',
    ])
    const period = await s.browser.call(
      'GET',
      `${s.base}/export?search=B12C34000560007&filter[from]=2026-11-01`,
    )
    expect(period.statusCode).toBe(200)
    expect(lines(period.body)).toEqual([
      expect.stringMatching(/;Sopra budget;CIG;CUP;Costo del periodo$/),
      'Scuola;C-1;Da iniziare;0,00;0,00;120,00;120,00;100,00;-20,00;Sì;12345ABCDE;B12C34000560007;120,00',
    ])
  })

  it('do not find the sites of another company from their codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ99999' where id = $1`, [s.ids[0]])
    expect(await names(stranger, '?search=ZZZZZ99999')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.base}?search=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })
})
