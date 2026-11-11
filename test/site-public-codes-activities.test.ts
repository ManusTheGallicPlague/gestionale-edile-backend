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
  const { company, user } = await fx.companyWithUser(['sites.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, values: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...values])).rows[0]?.id ?? ''
  const site = await one(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const cigOnly = await one(
    `insert into public.sites (company_id, name, code, cig)
       values ($1, 'Palestra', 'C-3', '99999XYZWV') returning id`,
  )
  const plain = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  for (const [s, start] of [
    [site, '2026-11-02'],
    [cigOnly, '2026-11-03'],
    [plain, '2026-11-04'],
  ]) {
    await one(
      `insert into public.site_activities (company_id, site_id, name, start_on, end_on, progress)
         values ($1, $2, 'Intonaci', $3, $3, 0) returning id`,
      [s, start],
    )
  }
  return { browser, company, site, url: `/api/companies/${company.slug}/activities` }
}

type Scene = Awaited<ReturnType<typeof scene>>

interface Listed {
  data: { site: { name: string; cig: string | null; cup: string | null } }[]
  meta: { total: number }
}

const list = async (s: Scene, q?: string) => {
  const res = await s.browser.call(
    'GET',
    q === undefined ? s.url : `${s.url}?filter[q]=${encodeURIComponent(q)}`,
  )
  expect(res.statusCode).toBe(200)
  return res.json<Listed>()
}

const csvRows = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the schedule of all the sites', () => {
  it('show the codes of the site of every activity, null when missing', async () => {
    const s = await scene()
    const sites = (await list(s)).data.map((d) => d.site)
    expect(sites.map((x) => [x.name, x.cig, x.cup])).toEqual([
      ['Scuola', '12345ABCDE', 'B12C34000560007'],
      ['Palestra', '99999XYZWV', null],
      ['Villetta', null, null],
    ])
  })

  it('find the activities from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      const found = await list(s, q)
      expect(found.data.map((d) => d.site.name)).toEqual(['Scuola'])
      expect(found.meta.total).toBe(1)
    }
    // The name of the activity and of the site are searched as before.
    expect((await list(s, 'intonaci')).meta.total).toBe(3)
    expect((await list(s, 'villetta')).data.map((d) => d.site.name)).toEqual(['Villetta'])
  })

  it('put CIG and CUP at the end of cronoprogramma.csv, empty when missing', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.url}/export`)
    expect(res.statusCode).toBe(200)
    const rows = csvRows(res.body)
    expect(rows[0]).toMatch(/;Giorni lavorativi rimanenti;CIG;CUP$/)
    expect(rows[1]).toMatch(/^Scuola;.*;12345ABCDE;B12C34000560007$/)
    expect(rows[2]).toMatch(/^Palestra;.*;99999XYZWV;$/)
    expect(rows[3]).toMatch(/^Villetta;.*;;$/)
    const found = await s.browser.call('GET', `${s.url}/export?filter[q]=b12c%203400`)
    expect(csvRows(found.body)).toHaveLength(2)
  })

  it('do not find the activities of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ88888' where id = $1`, [s.site])
    expect((await list(stranger, 'ZZZZZ88888')).meta.total).toBe(0)
    const res = await stranger.browser.call('GET', `${s.url}?filter[q]=ZZZZZ88888`)
    expect(res.statusCode).toBe(404)
    const csv = await stranger.browser.call('GET', `${stranger.url}/export?filter[q]=ZZZZZ88888`)
    expect(csvRows(csv.body)).toHaveLength(1)
  })

  it('need sites.view', async () => {
    const s = await scene()
    const { company, user } = await fx.companyWithUser(['reports.view'])
    const blind = new Browser(ctx.app)
    await blind.signIn(user.email)
    const url = `/api/companies/${company.slug}/activities`
    expect((await blind.call('GET', `${url}?filter[q]=1`)).statusCode).toBe(403)
    expect((await blind.call('GET', `${url}/export?filter[q]=1`)).statusCode).toBe(403)
    expect((await blind.call('GET', `${s.url}?filter[q]=1`)).statusCode).toBe(404)
  })
})
