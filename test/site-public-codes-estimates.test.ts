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
  const { company, user } = await fx.companyWithUser(['estimates.view', 'estimates.create'])
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
    base: `/api/companies/${company.slug}/estimates`,
  }
  for (const [title, site] of [
    ['Computo scuola', s.site],
    ['Computo villetta', s.plain],
    ['Computo senza cantiere', null],
  ] as const) {
    const created = await browser.call('POST', s.base, {
      body: {
        title,
        client_id: null,
        site_id: site,
        site_address: null,
        status: 'draft',
        notes: null,
      },
    })
    expect(created.statusCode).toBe(201)
  }
  return s
}

type Scene = Awaited<ReturnType<typeof scene>>

const titles = async (s: Scene, query: string) => {
  const res = await s.browser.call('GET', `${s.base}${query}`)
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { title: string }[] }>().data.map((d) => d.title)
}

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the estimates', () => {
  it('carry the codes of the site in the list and in the estimate', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}?sort=title`)
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { id: string; site: unknown }[] }>().data
    expect(data.map((d) => d.site)).toEqual([
      { id: s.site, name: 'Scuola', code: 'C-1', cig: '12345ABCDE', cup: 'B12C34000560007' },
      null,
      { id: s.plain, name: 'Villetta', code: 'C-2', cig: null, cup: null },
    ])
    const one = await s.browser.call('GET', `${s.base}/${data[0]?.id ?? ''}`)
    expect(one.statusCode).toBe(200)
    expect(one.json<{ site: { cup: string } }>().site.cup).toBe('B12C34000560007')
  })

  it('find the estimates from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await titles(s, `?search=${encodeURIComponent(q)}`)).toEqual(['Computo scuola'])
    }
    // Title is searched as before, and the count follows the search.
    expect(await titles(s, '?search=computo')).toHaveLength(3)
    const list = await s.browser.call('GET', `${s.base}?search=12345abcde`)
    expect(list.json<{ meta: { total: number } }>().meta.total).toBe(1)
    // A space alone matches neither code: an estimate without a site is never found by it.
    expect(await titles(s, `?search=${encodeURIComponent('x y')}`)).toEqual([])
  })

  it('end computi.csv with the CIG and CUP columns, following the search', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export?sort=title`)
    expect(res.statusCode).toBe(200)
    const [head, ...rows] = lines(res.body)
    expect(head).toMatch(/;Note;CIG;CUP$/)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatch(/^Computo senza cantiere;.*;;$/)
    expect(rows[0]).toMatch(/^Computo scuola;.*;12345ABCDE;B12C34000560007$/)
    expect(rows[2]).toMatch(/^Computo villetta;.*;;$/)
    const filtered = await s.browser.call('GET', `${s.base}/export?search=B12C34000560007`)
    expect(lines(filtered.body)).toHaveLength(2)
  })

  it('do not find the estimates of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ99999' where id = $1`, [s.site])
    expect(await titles(stranger, '?search=ZZZZZ99999')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.base}?search=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })

  it('need estimates.view', async () => {
    const s = await scene()
    const { company, user } = await fx.companyWithUser(['sites.view'])
    const blind = new Browser(ctx.app)
    await blind.signIn(user.email)
    const res = await blind.call('GET', `/api/companies/${company.slug}/estimates?search=12345`)
    expect(res.statusCode).toBe(403)
    expect((await blind.call('GET', `${s.base}?search=12345`)).statusCode).toBe(404)
  })
})
