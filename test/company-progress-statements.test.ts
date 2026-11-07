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

const ALL: Permission[] = ['estimates.view', 'invoices.view', 'invoices.create']

/**
 * Three estimates: «Villetta» on site C-1 with an approved SAL (1000.00, 5% retention) and a
 * draft one (300.00), «Box» on site C-2 with an approved and invoiced SAL (100.00, 10%), and
 * «Muro» without a site with an approved SAL (50.00, rounded from 49.995).
 */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, params: unknown[]) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  const site = (name: string, code: string) =>
    one('insert into public.sites (company_id, name, code) values ($1, $2, $3) returning id', [
      name,
      code,
    ])
  const villetta = await site('Villetta', 'C-1')
  const box = await site('Box', 'C-2')
  const estimate = async (title: string, siteId: string | null, cents: number) => {
    const id = await one(
      'insert into public.estimates (company_id, title, site_id) values ($1, $2, $3) returning id',
      [title, siteId],
    )
    const chapter = await one(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Opere', 0) returning id`,
      [id],
    )
    const item = await one(
      `insert into public.estimate_items (company_id, estimate_id, chapter_id, description,
         unit, unit_price_cents, position) values ($1, $2, $3, 'Voce', 'm²', $4, 0) returning id`,
      [id, chapter, cents],
    )
    return { id, item }
  }
  const statement = async (
    e: { id: string; item: string },
    number: number,
    date: string,
    status: 'draft' | 'approved',
    retention: string,
    quantity: string,
  ) => {
    const id = await one(
      `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
         status, approved_at, retention_percent)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [e.id, number, date, status, status === 'approved' ? new Date() : null, retention],
    )
    await ctx.owner.query(
      `insert into public.progress_statement_lines (company_id, estimate_id, statement_id,
         item_id, quantity, unit_price_cents)
       select $1, $2, $3, $4, $5, unit_price_cents from public.estimate_items where id = $4`,
      [company.id, e.id, id, e.item, quantity],
    )
    return id
  }
  const e1 = await estimate('Villetta', villetta, 10000)
  const e2 = await estimate('Box', box, 5000)
  const e3 = await estimate('Muro', null, 3333)
  const v1 = await statement(e1, 1, '2026-09-30', 'approved', '5.00', '10')
  const v2 = await statement(e1, 2, '2026-10-31', 'draft', '0', '3')
  const b1 = await statement(e2, 1, '2026-10-15', 'approved', '10.00', '2')
  const m1 = await statement(e3, 1, '2026-11-01', 'approved', '0', '1.5')
  const base = `/api/companies/${company.slug}`
  if (permissions.includes('invoices.create')) {
    const client = await one(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
      [],
    )
    const res = await browser.call('POST', `${base}/invoices`, {
      body: {
        direction: 'issued',
        number: '7/2026',
        date: '2026-10-20',
        client_id: client,
        supplier_id: null,
        site_id: box,
        description: 'SAL n. 1',
        taxable_amount: '100.00',
        vat_amount: '10.00',
        due_date: null,
        paid_on: null,
        notes: null,
        progress_statement_id: b1,
      },
    })
    expect(res.statusCode).toBe(201)
  }
  return {
    browser,
    company,
    villetta,
    box,
    e1,
    e2,
    e3,
    v1,
    v2,
    b1,
    m1,
    url: `${base}/progress-statements`,
  }
}

type List = {
  data: {
    id: string
    number: number
    amount: string
    previous_amount: string
    cumulative_amount: string
    net_amount: string
    invoice_id: string | null
    estimate: { id: string; title: string }
    site: { id: string; name: string; code: string | null } | null
  }[]
  meta: { total: number; page: number; per_page: number }
  total_amount: string
  total_net_amount: string
}

describe('progress statements of the whole company', () => {
  it('lists every SAL, newest first, with estimate, site and totals', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const list = res.json<List>()
    expect(list.data.map((r) => r.id)).toEqual([s.m1, s.v2, s.b1, s.v1])
    expect(list.data[0]).toMatchObject({
      amount: '50.00',
      net_amount: '50.00',
      invoice_id: null,
      estimate: { id: s.e3.id, title: 'Muro' },
      site: null,
    })
    expect(list.data[1]).toMatchObject({
      number: 2,
      status: 'draft',
      amount: '300.00',
      previous_amount: '1000.00',
      cumulative_amount: '1300.00',
      estimate: { id: s.e1.id, title: 'Villetta' },
      site: { id: s.villetta, name: 'Villetta', code: 'C-1' },
    })
    expect(list.data[2]).toMatchObject({ amount: '100.00', net_amount: '90.00' })
    expect(list.data[2]?.invoice_id).not.toBeNull()
    expect(list.data[3]).toMatchObject({ amount: '1000.00', net_amount: '950.00' })
    expect(list.meta).toEqual({ total: 4, page: 1, per_page: 25 })
    expect(list.total_amount).toBe('1450.00')
    expect(list.total_net_amount).toBe('1390.00')
  })

  it('filters by site, status, invoice and date, with totals on the filter', async () => {
    const s = await scene()
    const get = async (query: string) => {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<List>()
    }
    const toInvoice = await get('filter[status]=approved&filter[invoiced]=false')
    expect(toInvoice.data.map((r) => r.id)).toEqual([s.m1, s.v1])
    expect(toInvoice.total_amount).toBe('1050.00')
    expect(toInvoice.total_net_amount).toBe('1000.00')
    expect((await get('filter[invoiced]=true')).data.map((r) => r.id)).toEqual([s.b1])
    expect((await get(`filter[site]=${s.villetta}`)).data.map((r) => r.id)).toEqual([s.v2, s.v1])
    expect((await get('filter[status]=draft')).data.map((r) => r.id)).toEqual([s.v2])
    const october = await get('filter[from]=2026-10-01&filter[to]=2026-10-31')
    expect(october.data.map((r) => r.id)).toEqual([s.v2, s.b1])
    expect(october.total_amount).toBe('400.00')
    const page = await get('per_page=2&page=2')
    expect(page.data.map((r) => r.id)).toEqual([s.b1, s.v1])
    expect(page.meta).toEqual({ total: 4, page: 2, per_page: 2 })
    expect(page.total_amount).toBe('1450.00')
  })

  it('rejects wrong filters with 422', async () => {
    const s = await scene(['estimates.view'])
    for (const query of [
      'filter[invoiced]=si',
      'filter[status]=sent',
      'filter[from]=31/10/2026',
      'filter[site]=abc',
      'per_page=101',
    ]) {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode, query).toBe(422)
    }
  })

  it("never shows another company's SAL", async () => {
    const ours = await scene(['estimates.view'])
    const theirs = await scene(['estimates.view'])
    expect((await theirs.browser.call('GET', ours.url)).statusCode).toBe(404)
    const list = (await theirs.browser.call('GET', theirs.url)).json<List>()
    expect(list.data.map((r) => r.id).sort()).toEqual(
      [theirs.m1, theirs.v2, theirs.b1, theirs.v1].sort(),
    )
    const filtered = await theirs.browser.call('GET', `${theirs.url}?filter[site]=${ours.villetta}`)
    expect(filtered.json<List>()).toMatchObject({ data: [], total_amount: '0.00' })
  })

  it('is 403 without estimates.view and 401 without a session', async () => {
    const s = await scene(['invoices.view'])
    expect((await s.browser.call('GET', s.url)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', s.url)).statusCode).toBe(401)
  })
})

describe('progress statements of the whole company in CSV', () => {
  it('exports the filtered SAL in the order of the list', async () => {
    const s = await scene()
    const all = await s.browser.call('GET', `${s.url}/export`)
    expect(all.statusCode).toBe(200)
    expect(all.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(all.headers['content-disposition']).toBe('attachment; filename="sal.csv"')
    expect(all.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Data;Cantiere;Computo;SAL n.;Stato;Importo;Ritenuta %;Ritenuta;Netto;Fatturato',
      '01/11/2026;;Muro;1;Approvato;50,00;0,00;0,00;50,00;No',
      '31/10/2026;Villetta;Villetta;2;Bozza;300,00;0,00;0,00;300,00;No',
      '15/10/2026;Box;Box;1;Approvato;100,00;10,00;10,00;90,00;Sì',
      '30/09/2026;Villetta;Villetta;1;Approvato;1000,00;5,00;50,00;950,00;No',
    ])
    const toInvoice = await s.browser.call(
      'GET',
      `${s.url}/export?filter[status]=approved&filter[invoiced]=false&filter[from]=2026-10-01`,
    )
    expect(toInvoice.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Data;Cantiere;Computo;SAL n.;Stato;Importo;Ritenuta %;Ritenuta;Netto;Fatturato',
      '01/11/2026;;Muro;1;Approvato;50,00;0,00;0,00;50,00;No',
    ])
    expect((await s.browser.call('GET', `${s.url}/export?filter[invoiced]=1`)).statusCode).toBe(422)
  })

  it('is 404 for another company, 403 without estimates.view, 401 without a session', async () => {
    const ours = await scene(['estimates.view'])
    const theirs = await scene(['estimates.view'])
    expect((await theirs.browser.call('GET', `${ours.url}/export`)).statusCode).toBe(404)
    const blind = await scene(['invoices.view'])
    expect((await blind.browser.call('GET', `${blind.url}/export`)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', `${ours.url}/export`)).statusCode).toBe(401)
  })
})

describe('progress statements in the dashboard', () => {
  it('counts drafts and the approved SAL to invoice, only of the company', async () => {
    const s = await scene()
    await scene() // Another company with the same SAL must not double the counts.
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ progress_statements: unknown }>().progress_statements).toEqual({
      drafts: 1,
      to_invoice: 2,
      to_invoice_amount: '1050.00',
      to_invoice_net_amount: '1000.00',
    })
    const blind = await scene(['invoices.view'])
    const other = await blind.browser.call('GET', `/api/companies/${blind.company.slug}/dashboard`)
    expect(other.json<{ progress_statements: unknown }>().progress_statements).toBeNull()
  })
})
