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

async function scene(permissions: Permission[] = ['sites.view', 'clients.view', 'suppliers.view']) {
  const { company } = await fx.companyWithUser(['sites.view'])
  const user = await fx.user()
  const role = await fx.role(company.id, 'Ufficio', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string, params: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  const client = await insert(
    "insert into public.clients (company_id, kind, name) values ($1, 'company', 'Comune di prova') returning id",
  )
  const supplier = await insert(
    "insert into public.suppliers (company_id, name) values ($1, 'Impianti di prova') returning id",
  )
  const school = await insert(
    `insert into public.sites (company_id, name, code, client_id, cig, cup)
       values ($1, 'Scuola', 'C-1', $2, '12345ABCDE', 'B12C34000560007') returning id`,
    [client],
  )
  const gym = await insert(
    `insert into public.sites (company_id, name, code, client_id, cig)
       values ($1, 'Palestra', 'C-2', $2, '98765ZYXWV') returning id`,
    [client],
  )
  const house = await insert(
    `insert into public.sites (company_id, name, code, client_id)
       values ($1, 'Villetta', 'C-3', $2) returning id`,
    [client],
  )
  for (const site of [school, gym, house]) {
    await ctx.owner.query(
      `insert into public.site_costs (company_id, site_id, supplier_id, cost_date, category,
         description, amount_cents) values ($1, $2, $3, '2026-01-10', 'subcontract', 'x', 100)`,
      [company.id, site, supplier],
    )
  }
  const base = `/api/companies/${company.slug}`
  return { browser, company, client, supplier, school, gym, house, base }
}

const lines = (body: string) => body.replace('﻿', '').trim().split('\r\n')

describe('CIG and CUP of the site in the sites of a client and of a supplier', () => {
  it('are in the sites of the client and at the end of its CSV', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/sites`)
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { site_id: string; cig: string | null; cup: string | null }[] }>()
      .data
    expect(data.map((r) => [r.site_id, r.cig, r.cup])).toEqual([
      [s.gym, '98765ZYXWV', null],
      [s.school, '12345ABCDE', 'B12C34000560007'],
      [s.house, null, null],
    ])
    const csv = await s.browser.call('GET', `${s.base}/clients/${s.client}/sites/export`)
    expect(csv.statusCode).toBe(200)
    expect(lines(csv.body)).toEqual([
      'Codice;Cantiere;Stato;CIG;CUP',
      'C-2;Palestra;Da iniziare;98765ZYXWV;',
      'C-1;Scuola;Da iniziare;12345ABCDE;B12C34000560007',
      'C-3;Villetta;Da iniziare;;',
    ])
  })

  it('are in the sites of the supplier and at the end of its CSV, after the amounts', async () => {
    const s = await scene(['sites.view', 'suppliers.view', 'costs.view'])
    const res = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/sites`)
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { site_id: string; cig: string | null; cup: string | null }[] }>()
      .data
    expect(data.map((r) => [r.site_id, r.cig, r.cup])).toEqual([
      [s.gym, '98765ZYXWV', null],
      [s.school, '12345ABCDE', 'B12C34000560007'],
      [s.house, null, null],
    ])
    const csv = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/sites/export`)
    expect(csv.statusCode).toBe(200)
    expect(lines(csv.body)).toEqual([
      'Codice;Cantiere;Stato;Costi;CIG;CUP',
      'C-2;Palestra;Da iniziare;1,00;98765ZYXWV;',
      'C-1;Scuola;Da iniziare;1,00;12345ABCDE;B12C34000560007',
      'C-3;Villetta;Da iniziare;1,00;;',
    ])
  })

  it('follow the site when the office corrects the code', async () => {
    const s = await scene()
    await ctx.owner.query("update public.sites set cig = '11111AAAAA', cup = null where id = $1", [
      s.school,
    ])
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/sites`)
    const school = res
      .json<{ data: { site_id: string; cig: string | null; cup: string | null }[] }>()
      .data.find((r) => r.site_id === s.school)
    expect(school).toMatchObject({ cig: '11111AAAAA', cup: null })
  })

  it('never show the codes of another company', async () => {
    const mine = await scene()
    const theirs = await scene()
    for (const url of [
      `${mine.base}/clients/${theirs.client}/sites`,
      `${mine.base}/clients/${theirs.client}/sites/export`,
      `${mine.base}/suppliers/${theirs.supplier}/sites`,
      `${mine.base}/suppliers/${theirs.supplier}/sites/export`,
      `${theirs.base}/clients/${theirs.client}/sites`,
      `${theirs.base}/suppliers/${theirs.supplier}/sites/export`,
    ]) {
      const res = await mine.browser.call('GET', url)
      expect(res.statusCode).toBe(404)
      expect(res.body).not.toContain('12345ABCDE')
    }
  })

  it('are not shown without sites.view', async () => {
    const s = await scene(['clients.view', 'suppliers.view'])
    for (const url of [
      `${s.base}/clients/${s.client}/sites`,
      `${s.base}/clients/${s.client}/sites/export`,
      `${s.base}/suppliers/${s.supplier}/sites`,
      `${s.base}/suppliers/${s.supplier}/sites/export`,
    ]) {
      const res = await s.browser.call('GET', url)
      expect(res.statusCode).toBe(403)
      expect(res.body).not.toContain('12345ABCDE')
    }
  })
})
