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
  const { company, user } = await fx.companyWithUser(['warehouse.view'])
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
  const item = await one(
    `insert into public.warehouse_items (company_id, code, name, unit)
       values ($1, 'CEM', 'Cemento', 'sacchi') returning id`,
  )
  await one(
    `insert into public.warehouse_movements (company_id, item_id, movement_date, kind, quantity)
       values ($1, $2, '2026-11-02', 'in', 100) returning id`,
    [item],
  )
  for (const [s, day] of [
    [site, '2026-11-03'],
    [plain, '2026-11-04'],
  ]) {
    await one(
      `insert into public.warehouse_movements
         (company_id, item_id, movement_date, kind, quantity, site_id)
       values ($1, $2, $3, 'out', 5, $4) returning id`,
      [item, day, s],
    )
  }
  return { browser, site, moves: `/api/companies/${company.slug}/warehouse/movements` }
}

type Scene = Awaited<ReturnType<typeof scene>>

const found = async (s: Scene, q: string) => {
  const res = await s.browser.call('GET', `${s.moves}?filter[q]=${encodeURIComponent(q)}`)
  expect(res.statusCode).toBe(200)
  const body = res.json<{ data: { site: { name: string } | null }[]; meta: { total: number } }>()
  expect(body.meta.total).toBe(body.data.length)
  return body.data.map((d) => d.site?.name ?? null)
}

describe('CIG and CUP of the site in the search of the warehouse movements', () => {
  it('find the movements from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      expect(await found(s, q)).toEqual(['Scuola'])
    }
    // Notes, item code and item name are searched as before.
    expect(await found(s, 'cemento')).toHaveLength(3)
  })

  it('apply the same search to movimenti-magazzino.csv', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.moves}/export?filter[q]=B12C34000560007`)
    expect(res.statusCode).toBe(200)
    const rows = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Scuola')
  })

  it('do not find the movements of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ77777' where id = $1`, [s.site])
    expect(await found(stranger, 'ZZZZZ77777')).toEqual([])
    const res = await stranger.browser.call('GET', `${s.moves}?filter[q]=ZZZZZ77777`)
    expect(res.statusCode).toBe(404)
  })

  it('need warehouse.view', async () => {
    const { company, user } = await fx.companyWithUser(['sites.view'])
    const blind = new Browser(ctx.app)
    await blind.signIn(user.email)
    const url = `/api/companies/${company.slug}/warehouse/movements`
    expect((await blind.call('GET', `${url}?filter[q]=1`)).statusCode).toBe(403)
    expect((await blind.call('GET', `${url}/export?filter[q]=1`)).statusCode).toBe(403)
  })
})
