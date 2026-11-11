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
  const { company, user } = await fx.companyWithUser(['deadlines.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, cig, cup) values
       ($1, 'Scuola', '12345ABCDE', 'B12C34000560007'),
       ($1, 'Villetta', null, null)
     returning id`,
    [company.id],
  )
  const deadlines = await ctx.owner.query<{ id: string }>(
    `insert into public.deadlines (company_id, title, due_on, kind, site_id) values
       ($1, 'Polizza fideiussoria', '2026-11-30', 'insurance', $2),
       ($1, 'Collaudo', '2026-12-15', 'contract', $3),
       ($1, 'F24 IVA', '2026-12-16', 'tax', null)
     returning id`,
    [company.id, sites.rows[0]?.id, sites.rows[1]?.id],
  )
  return {
    browser,
    polizza: deadlines.rows[0]?.id,
    base: `/api/companies/${company.slug}/deadlines`,
  }
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

describe('CIG and CUP of the site in the deadlines', () => {
  it('find the deadlines from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await titles(s, `?search=${encodeURIComponent(q)}`)).toEqual(['Polizza fideiussoria'])
    }
    // Title and notes are searched as before; a space between CIG and CUP finds nothing.
    expect(await titles(s, '?search=collaudo')).toEqual(['Collaudo'])
    expect(await titles(s, `?search=${encodeURIComponent('ABCDE B12C')}`)).toEqual([])
    const res = await s.browser.call('GET', `${s.base}?search=12345abcde`)
    expect(res.json<{ meta: { total: number } }>().meta.total).toBe(1)
  })

  it('put the CIG and CUP columns in scadenze.csv, before the first working day', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/export`)
    expect(res.statusCode).toBe(200)
    const [head, ...rows] = lines(res.body)
    expect(head).toMatch(/;Note;CIG;CUP;Primo giorno lavorativo$/)
    expect(rows.map((r) => r.split(';').slice(-3))).toEqual([
      ['12345ABCDE', 'B12C34000560007', '30/11/2026'],
      ['', '', '15/12/2026'],
      ['', '', '16/12/2026'],
    ])
    const filtered = await s.browser.call('GET', `${s.base}/export?search=B12C34000560007`)
    expect(lines(filtered.body)).toHaveLength(2)
  })

  it('do not find the deadlines of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(
      `update public.sites set cig = 'ZZZZZ99999'
         where id = (select site_id from public.deadlines where id = $1)`,
      [s.polizza],
    )
    expect(await titles(stranger, '?search=ZZZZZ99999')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.base}?search=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })
})
