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

const ALL: Permission[] = [
  'clients.view',
  'suppliers.view',
  'invoices.view',
  'invoices.create',
  'invoices.update',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Amministrazione', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const client = await insert(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
  )
  const other = await insert(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Anna Verdi') returning id",
  )
  const supplier = await insert(
    "insert into public.suppliers (company_id, name) values ($1, 'Laterizi di prova') returning id",
  )
  const base = `/api/companies/${company.slug}`
  return { browser, company, client, other, supplier, base }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function invoice(s: Scene, browser: Browser, overrides: Record<string, unknown>) {
  const res = await browser.call('POST', `${s.base}/invoices`, {
    body: {
      direction: 'issued',
      number: `F-${Math.random().toString(36).slice(2, 8)}`,
      date: '2026-01-10',
      client_id: s.client,
      supplier_id: null,
      site_id: null,
      description: null,
      taxable_amount: '1000',
      vat_amount: '220',
      due_date: '2099-12-31',
      paid_on: null,
      notes: null,
      ...overrides,
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ id: string }>()
}

describe('statement of account', () => {
  it('sums the issued invoices of a client: paid, partly paid, overdue', async () => {
    const s = await scene()
    // Paid in full, with no payment registered: all settled.
    await invoice(s, s.browser, { paid_on: '2026-01-20', due_date: '2026-01-31' })
    // Overdue, with an advance: only the rest is overdue.
    const late = await invoice(s, s.browser, { due_date: '2026-02-28' })
    const pay = await s.browser.call('POST', `${s.base}/invoices/${late.id}/payments`, {
      body: { date: '2026-02-10', amount: '200.50', method: null, notes: null },
      headers: { 'If-Match': '"1"' },
    })
    expect(pay.statusCode).toBe(200)
    // Not yet due, with withholding and split payment: amount due without both.
    await invoice(s, s.browser, {
      taxable_amount: '500',
      vat_amount: '110',
      withholding_amount: '100',
      split_payment: true,
    })
    // Another client's and a received invoice do not count.
    await invoice(s, s.browser, { client_id: s.other })
    await invoice(s, s.browser, { direction: 'received', client_id: null, supplier_id: s.supplier })

    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      invoice_count: 3,
      open_invoice_count: 2,
      total: '3050.00',
      amount_due: '2840.00',
      settled: '1420.50',
      outstanding: '1419.50',
      overdue: '1019.50',
    })
  })

  it('sums the received invoices of a supplier; zero without invoices', async () => {
    const s = await scene()
    const empty = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)
    expect(empty.json()).toEqual({
      invoice_count: 0,
      open_invoice_count: 0,
      total: '0.00',
      amount_due: '0.00',
      settled: '0.00',
      outstanding: '0.00',
      overdue: '0.00',
    })
    await invoice(s, s.browser, {
      direction: 'received',
      client_id: null,
      supplier_id: s.supplier,
      taxable_amount: '99.99',
      vat_amount: '22',
      due_date: '2026-03-01',
    })
    const res = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)
    expect(res.json()).toMatchObject({
      invoice_count: 1,
      total: '121.99',
      outstanding: '121.99',
      overdue: '121.99',
      settled: '0.00',
    })
  })

  it('works for an archived client', async () => {
    const s = await scene()
    await invoice(s, s.browser, {})
    await ctx.owner.query('update public.clients set archived_at = now() where id = $1', [s.client])
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ invoice_count: 1, outstanding: '1220.00' })
  })

  it('is 404 for another company, an unknown id or without the view permission', async () => {
    const s = await scene()
    const t = await scene()
    await invoice(t, t.browser, {})
    // The other company's client, through our company and through theirs.
    expect((await s.browser.call('GET', `${s.base}/clients/${t.client}/account`)).statusCode).toBe(
      404,
    )
    expect((await s.browser.call('GET', `${t.base}/clients/${t.client}/account`)).statusCode).toBe(
      404,
    )
    expect(
      (await s.browser.call('GET', `${s.base}/suppliers/${t.supplier}/account`)).statusCode,
    ).toBe(404)
    expect(
      (
        await s.browser.call(
          'GET',
          `${s.base}/clients/00000000-0000-4000-8000-000000000000/account`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await s.browser.call('GET', `${s.base}/clients/nope/account`)).statusCode).toBe(404)

    const blind = await scene(['invoices.view', 'suppliers.view'])
    expect(
      (await blind.browser.call('GET', `${blind.base}/clients/${blind.client}/account`)).statusCode,
    ).toBe(404)
  })

  it('is 403 without invoices.view and 401 without a session', async () => {
    const s = await scene(['clients.view', 'suppliers.view'])
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(403)
    expect(
      (await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)).statusCode,
    ).toBe(403)
    const anon = new Browser(ctx.app)
    expect((await anon.call('GET', `${s.base}/clients/${s.client}/account`)).statusCode).toBe(401)
  })
})
