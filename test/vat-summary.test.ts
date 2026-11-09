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

const ALL: Permission[] = ['invoices.view', 'invoices.create', 'invoices.update']

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
  const supplier = await insert(
    "insert into public.suppliers (company_id, name) values ($1, 'Laterizi di prova') returning id",
  )
  // The owner's browser writes the invoices, whatever the permissions under test.
  const writer = new Browser(ctx.app)
  const owner = await fx.user()
  await fx.member(owner.id, company.id, await fx.role(company.id, 'Scrive', ALL))
  await writer.signIn(owner.email)
  return { browser, writer, client, supplier, base: `/api/companies/${company.slug}` }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function invoice(s: Scene, overrides: Record<string, unknown>) {
  const res = await s.writer.call('POST', `${s.base}/invoices`, {
    body: {
      direction: 'issued',
      number: `F-${Math.random().toString(36).slice(2, 8)}`,
      date: '2025-01-15',
      client_id: s.client,
      supplier_id: null,
      site_id: null,
      description: null,
      taxable_amount: '1000',
      vat_amount: '220',
      due_date: null,
      paid_on: null,
      notes: null,
      ...overrides,
    },
  })
  expect(res.statusCode).toBe(201)
}

const received = (s: Scene) => ({ direction: 'received', client_id: null, supplier_id: s.supplier })
const zero = {
  sales_taxable: '0.00',
  sales_vat: '0.00',
  sales_split_payment_vat: '0.00',
  purchases_taxable: '0.00',
  purchases_vat: '0.00',
  reverse_charge_taxable: '0.00',
  balance: '0.00',
}

describe('VAT summary', () => {
  it('sums taxable and VAT by month of the invoice date, with the balance', async () => {
    const s = await scene()
    // January: a paid sale with withholding (VAT unchanged), a split payment sale to the PA.
    await invoice(s, { paid_on: '2025-01-20', withholding_amount: '200' })
    await invoice(s, {
      date: '2025-01-31',
      taxable_amount: '500',
      vat_amount: '110',
      split_payment: true,
    })
    // February: a purchase with more VAT than the sales, and one in reverse charge.
    await invoice(s, {
      ...received(s),
      date: '2025-02-01',
      taxable_amount: '3000',
      vat_amount: '660',
    })
    await invoice(s, {
      ...received(s),
      date: '2025-02-28',
      taxable_amount: '800',
      vat_amount: '0',
      vat_nature: 'N6.7',
    })
    // An exempt purchase (N4) is not reverse charge; other years stay out.
    await invoice(s, {
      ...received(s),
      date: '2025-03-10',
      taxable_amount: '50',
      vat_amount: '0',
      vat_nature: 'N4',
    })
    await invoice(s, { date: '2024-12-31' })
    await invoice(s, { date: '2026-01-01' })

    const res = await s.browser.call('GET', `${s.base}/vat-summary?year=2025`)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      year: number
      period: string
      periods: Record<string, string>[]
      total: unknown
    }>()
    expect(body.year).toBe(2025)
    expect(body.period).toBe('month')
    expect(body.periods).toHaveLength(12)
    expect(body.periods[0]).toEqual({
      period: '2025-01',
      from: '2025-01-01',
      to: '2025-01-31',
      ...zero,
      sales_taxable: '1500.00',
      sales_vat: '330.00',
      sales_split_payment_vat: '110.00',
      balance: '220.00',
    })
    expect(body.periods[1]).toEqual({
      period: '2025-02',
      from: '2025-02-01',
      to: '2025-02-28',
      ...zero,
      purchases_taxable: '3800.00',
      purchases_vat: '660.00',
      reverse_charge_taxable: '800.00',
      balance: '-660.00',
    })
    expect(body.periods[2]).toMatchObject({
      purchases_taxable: '50.00',
      reverse_charge_taxable: '0.00',
    })
    expect(body.periods[11]).toEqual({
      period: '2025-12',
      from: '2025-12-01',
      to: '2025-12-31',
      ...zero,
    })
    expect(body.total).toEqual({
      sales_taxable: '1500.00',
      sales_vat: '330.00',
      sales_split_payment_vat: '110.00',
      purchases_taxable: '3850.00',
      purchases_vat: '660.00',
      reverse_charge_taxable: '800.00',
      balance: '-440.00',
    })

    const q = await s.browser.call('GET', `${s.base}/vat-summary?year=2025&period=quarter`)
    expect(q.statusCode).toBe(200)
    const quarters = q.json<{ periods: Record<string, string>[] }>().periods
    expect(quarters.map((p) => [p.period, p.from, p.to, p.balance])).toEqual([
      ['2025-Q1', '2025-01-01', '2025-03-31', '-440.00'],
      ['2025-Q2', '2025-04-01', '2025-06-30', '0.00'],
      ['2025-Q3', '2025-07-01', '2025-09-30', '0.00'],
      ['2025-Q4', '2025-10-01', '2025-12-31', '0.00'],
    ])
  })

  it('defaults to the current Italian year and checks the parameters', async () => {
    const s = await scene()
    const { rows } = await ctx.owner.query<{ y: number }>(
      "select extract(year from now() at time zone 'Europe/Rome')::int as y",
    )
    const res = await s.browser.call('GET', `${s.base}/vat-summary`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ year: rows[0]?.y, period: 'month' })
    for (const bad of ['year=1999', 'year=abc', 'year=2101', 'period=week']) {
      const r = await s.browser.call('GET', `${s.base}/vat-summary?${bad}`)
      expect(r.statusCode).toBe(422)
      expect((await s.browser.call('GET', `${s.base}/vat-summary/export?${bad}`)).statusCode).toBe(
        422,
      )
    }
  })

  it('exports the summary in CSV', async () => {
    const s = await scene()
    await invoice(s, { date: '2025-05-02', taxable_amount: '1234.5', vat_amount: '271.59' })
    await invoice(s, {
      ...received(s),
      date: '2025-11-30',
      taxable_amount: '2000',
      vat_amount: '440',
    })
    const res = await s.browser.call('GET', `${s.base}/vat-summary/export?year=2025&period=quarter`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="riepilogo-iva-2025.csv"')
    expect(res.body).toBe(
      '﻿Periodo;Imponibile vendite;IVA vendite;di cui IVA in scissione;Imponibile acquisti;' +
        'IVA acquisti;Imponibile acquisti in inversione contabile;Saldo IVA\r\n' +
        '1° trimestre 2025;0,00;0,00;0,00;0,00;0,00;0,00;0,00\r\n' +
        '2° trimestre 2025;1234,50;271,59;0,00;0,00;0,00;0,00;271,59\r\n' +
        '3° trimestre 2025;0,00;0,00;0,00;0,00;0,00;0,00;0,00\r\n' +
        '4° trimestre 2025;0,00;0,00;0,00;2000,00;440,00;0,00;-440,00\r\n' +
        'Totale;1234,50;271,59;0,00;2000,00;440,00;0,00;-168,41\r\n',
    )
    const monthly = await s.browser.call('GET', `${s.base}/vat-summary/export?year=2025`)
    expect(monthly.body.split('\r\n')[5]).toBe('05/2025;1234,50;271,59;0,00;0,00;0,00;0,00;271,59')
  })

  it('sees only the invoices of its own company', async () => {
    const s = await scene()
    await invoice(s, { date: '2025-01-10' })
    const theirs = await scene()
    const res = await theirs.browser.call('GET', `${theirs.base}/vat-summary?year=2025`)
    expect(res.json()).toMatchObject({ total: zero })
    expect((await theirs.browser.call('GET', `${s.base}/vat-summary`)).statusCode).toBe(404)
    expect((await theirs.browser.call('GET', `${s.base}/vat-summary/export`)).statusCode).toBe(404)
  })

  it('needs invoices.view and a session', async () => {
    const s = await scene(['clients.view'])
    expect((await s.browser.call('GET', `${s.base}/vat-summary`)).statusCode).toBe(403)
    expect((await s.browser.call('GET', `${s.base}/vat-summary/export`)).statusCode).toBe(403)
    const anon = new Browser(ctx.app)
    expect((await anon.call('GET', `${s.base}/vat-summary`)).statusCode).toBe(401)
  })
})
