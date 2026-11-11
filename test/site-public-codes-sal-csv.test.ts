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

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

const HEADER =
  'Data;Cantiere;Computo;SAL n.;Stato;Importo;Ritenuta %;Ritenuta;Netto;Fatturato;CIG;CUP'

describe('CIG and CUP of the site in the CSV of the SAL', () => {
  it('are the last columns of sal.csv, read from the site', async () => {
    const s = await scene()
    const csv = await s.browser.call('GET', `${s.list}/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toBe('attachment; filename="sal.csv"')
    const rows = lines(csv.body)
    expect(rows[0]).toBe(HEADER)
    expect(rows.slice(1).sort()).toEqual([
      '31/10/2026;Scuola;Ampliamento scuola;1;Approvato;1000,00;5,00;50,00;950,00;No;12345ABCDE;B12C34000560007',
      '31/10/2026;Villetta;Villetta;1;Approvato;1000,00;5,00;50,00;950,00;No;;',
    ])

    await ctx.owner.query('update public.sites set cig = null where id = $1', [s.school])
    const onlyCup = lines((await s.browser.call('GET', `${s.list}/export`)).body)
    expect(onlyCup).toContain(
      '31/10/2026;Scuola;Ampliamento scuola;1;Approvato;1000,00;5,00;50,00;950,00;No;;B12C34000560007',
    )
  })

  it('follow the filters of the list, also searching by code', async () => {
    const s = await scene()
    for (const q of ['12345abcde', 'b12c34000560007']) {
      const csv = await s.browser.call('GET', `${s.list}/export?filter[q]=${encodeURIComponent(q)}`)
      expect(csv.statusCode).toBe(200)
      expect(lines(csv.body)).toEqual([
        HEADER,
        '31/10/2026;Scuola;Ampliamento scuola;1;Approvato;1000,00;5,00;50,00;950,00;No;12345ABCDE;B12C34000560007',
      ])
    }
    const house = await s.browser.call('GET', `${s.list}/export?filter[site]=${s.house}`)
    expect(lines(house.body)).toEqual([
      HEADER,
      '31/10/2026;Villetta;Villetta;1;Approvato;1000,00;5,00;50,00;950,00;No;;',
    ])
  })

  it('are not exported to another company', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query("update public.sites set cig = '99999ZZZZZ' where id = $1", [s.school])
    const csv = await stranger.browser.call('GET', `${stranger.list}/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).not.toContain('99999ZZZZZ')
    const found = await stranger.browser.call('GET', `${stranger.list}/export?filter[q]=99999ZZZZZ`)
    expect(lines(found.body)).toEqual([HEADER])
    const theirs = await stranger.browser.call('GET', `${s.list}/export`)
    expect(theirs.statusCode).toBe(404)
  })

  it('need estimates.view', async () => {
    const s = await scene([])
    expect((await s.browser.call('GET', `${s.list}/export`)).statusCode).toBe(403)
  })
})
