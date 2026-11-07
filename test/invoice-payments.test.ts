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

const ALL: Permission[] = ['invoices.view', 'invoices.create', 'invoices.update', 'deadlines.view']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Amministrazione', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client =
    (
      await ctx.owner.query<{ id: string }>(
        "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
        [company.id],
      )
    ).rows[0]?.id ?? ''
  return { browser, company, client, base: `/api/companies/${company.slug}/invoices` }
}

type Scene = Awaited<ReturnType<typeof scene>>

type Invoice = {
  id: string
  amount_due: string
  paid_amount: string
  remaining_amount: string
  paid_on: string | null
  payment_status: string
  deadline_id: string | null
}

async function invoice(s: Scene, overrides: Record<string, unknown> = {}) {
  const res = await s.browser.call('POST', s.base, {
    body: {
      direction: 'issued',
      number: `F-${Math.random().toString(36).slice(2, 8)}`,
      date: '2026-11-02',
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
  return res.json<Invoice>()
}

const payment = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-11-10',
  amount: '500',
  method: 'bank_transfer',
  notes: null,
  ...overrides,
})

describe('invoice payments', () => {
  it('partial payments lower what is left, then mark the invoice paid', async () => {
    const s = await scene()
    const inv = await invoice(s)
    expect(inv).toMatchObject({ paid_amount: '0.00', remaining_amount: '1220.00' })
    const url = `${s.base}/${inv.id}/payments`

    const first = await s.browser.call('POST', url, {
      body: payment(),
      headers: { 'If-Match': '"1"' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.headers.etag).toBe('"2"')
    expect(first.json()).toMatchObject({
      paid_amount: '500.00',
      remaining_amount: '720.00',
      paid_on: null,
      payment_status: 'open',
    })
    const deadlineUrl = `/api/companies/${s.company.slug}/deadlines/${inv.deadline_id}`
    expect((await s.browser.call('GET', deadlineUrl)).json()).toMatchObject({
      amount: '720.00',
      status: 'open',
    })

    // More than what is left: refused under amount, nothing changes.
    const tooMuch = await s.browser.call('POST', url, {
      body: payment({ amount: '720.01' }),
      headers: { 'If-Match': '"2"' },
    })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json<{ errors: Record<string, string[]> }>().errors.amount).toBeDefined()
    expect((await s.browser.call('GET', `${s.base}/${inv.id}`)).headers.etag).toBe('"2"')

    const last = await s.browser.call('POST', url, {
      body: payment({ date: '2026-11-20', amount: '720', method: null, notes: 'Saldo' }),
      headers: { 'If-Match': '"2"' },
    })
    expect(last.json()).toMatchObject({
      paid_amount: '1220.00',
      remaining_amount: '0.00',
      paid_on: '2026-11-20',
      payment_status: 'paid',
    })
    expect((await s.browser.call('GET', deadlineUrl)).json()).toMatchObject({ status: 'done' })

    const list = await s.browser.call('GET', url)
    expect(list.statusCode).toBe(200)
    const data = list.json<{ data: { id: string; amount: string; notes: string | null }[] }>().data
    expect(data.map((p) => p.amount)).toEqual(['500.00', '720.00'])
    expect(data[1]?.notes).toBe('Saldo')

    // Deleting the balance reopens the invoice and its deadline.
    const removed = await s.browser.call('DELETE', `${url}/${data[1]?.id}`, {
      headers: { 'If-Match': '"3"' },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toMatchObject({
      paid_amount: '500.00',
      remaining_amount: '720.00',
      paid_on: null,
    })
    expect((await s.browser.call('GET', deadlineUrl)).json()).toMatchObject({
      amount: '720.00',
      status: 'open',
    })
    // The last one gone: back to an unpaid invoice.
    const empty = await s.browser.call('DELETE', `${url}/${data[0]?.id}`, {
      headers: { 'If-Match': '"4"' },
    })
    expect(empty.json()).toMatchObject({ paid_amount: '0.00', remaining_amount: '1220.00' })
  })

  it('the register and the dashboard count only what is left', async () => {
    const s = await scene()
    const inv = await invoice(s, { due_date: '2026-11-03' })
    await s.browser.call('POST', `${s.base}/${inv.id}/payments`, {
      body: payment({ amount: '200' }),
      headers: { 'If-Match': '"1"' },
    })
    const list = await s.browser.call('GET', s.base)
    expect(list.json()).toMatchObject({ outstanding_amount: '1020.00' })
    const dashboard = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(dashboard.json()).toMatchObject({
      invoices: { receivable: '1020.00', receivable_overdue: '1020.00' },
    })
  })

  it('paid_on follows the payments, and amounts cannot drop below them', async () => {
    const s = await scene()
    const inv = await invoice(s)
    await s.browser.call('POST', `${s.base}/${inv.id}/payments`, {
      body: payment({ amount: '1000' }),
      headers: { 'If-Match': '"1"' },
    })
    const body = {
      direction: 'issued',
      number: 'X-1',
      date: '2026-11-02',
      client_id: s.client,
      supplier_id: null,
      site_id: null,
      description: null,
      taxable_amount: '1000',
      vat_amount: '220',
      due_date: '2099-12-31',
      paid_on: '2026-11-30',
      notes: null,
    }
    // paid_on sent while the payments do not cover the amount: ignored.
    const update = await s.browser.call('PUT', `${s.base}/${inv.id}`, {
      body,
      headers: { 'If-Match': '"2"' },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({ paid_on: null, remaining_amount: '220.00' })
    // Lowering the amounts to what is paid makes it paid on the last payment.
    const lower = await s.browser.call('PUT', `${s.base}/${inv.id}`, {
      body: { ...body, vat_amount: '0', paid_on: null },
      headers: { 'If-Match': '"3"' },
    })
    expect(lower.json()).toMatchObject({ paid_on: '2026-11-10', payment_status: 'paid' })
    // Below the payments: refused, and the invoice stays as it was.
    const below = await s.browser.call('PUT', `${s.base}/${inv.id}`, {
      body: { ...body, taxable_amount: '900', vat_amount: '0' },
      headers: { 'If-Match': '"4"' },
    })
    expect(below.statusCode).toBe(422)
    expect((await s.browser.call('GET', `${s.base}/${inv.id}`)).headers.etag).toBe('"4"')
  })

  it('checks the input, If-Match and an invoice already marked paid', async () => {
    const s = await scene()
    const inv = await invoice(s)
    const url = `${s.base}/${inv.id}/payments`
    const bad = await s.browser.call('POST', url, {
      body: { date: '2026-13-01', amount: '0', method: 'bitcoin' },
      headers: { 'If-Match': '"1"' },
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'amount',
      'date',
      'method',
      'notes',
    ])
    expect((await s.browser.call('POST', url, { body: payment() })).statusCode).toBe(428)
    expect(
      (await s.browser.call('POST', url, { body: payment(), headers: { 'If-Match': '"9"' } }))
        .statusCode,
    ).toBe(412)
    const missing = await s.browser.call('DELETE', `${url}/${crypto.randomUUID()}`, {
      headers: { 'If-Match': '"1"' },
    })
    expect(missing.statusCode).toBe(404)
    expect((await s.browser.call('GET', `${s.base}/${inv.id}`)).headers.etag).toBe('"1"')

    const paid = await invoice(s, { paid_on: '2026-11-05' })
    const again = await s.browser.call('POST', `${s.base}/${paid.id}/payments`, {
      body: payment(),
      headers: { 'If-Match': '"1"' },
    })
    expect(again.statusCode).toBe(422)
  })

  it('needs the invoices permissions; other companies see nothing', async () => {
    const s = await scene()
    const inv = await invoice(s)
    const url = `${s.base}/${inv.id}/payments`
    const viewer = await scene(['invoices.view'])
    const reader = await scene(['deadlines.view'])
    // Same company, fewer permissions.
    const role = await fx.role(s.company.id, 'Lettura', ['invoices.view'])
    const user = await fx.user()
    await fx.member(user.id, s.company.id, role)
    const onlyView = new Browser(ctx.app)
    await onlyView.signIn(user.email)
    expect((await onlyView.call('GET', url)).statusCode).toBe(200)
    expect(
      (await onlyView.call('POST', url, { body: payment(), headers: { 'If-Match': '"1"' } }))
        .statusCode,
    ).toBe(403)
    const role2 = await fx.role(s.company.id, 'Scadenze', ['deadlines.view'])
    const user2 = await fx.user()
    await fx.member(user2.id, s.company.id, role2)
    const noView = new Browser(ctx.app)
    await noView.signIn(user2.email)
    expect((await noView.call('GET', url)).statusCode).toBe(404)
    // Another company: its own path with this invoice is not found.
    for (const other of [viewer, reader]) {
      const foreign = `${other.base}/${inv.id}/payments`
      expect((await other.browser.call('GET', foreign)).statusCode).toBe(404)
    }
    const otherFull = await scene()
    const foreign = `${otherFull.base}/${inv.id}/payments`
    expect(
      (
        await otherFull.browser.call('POST', foreign, {
          body: payment(),
          headers: { 'If-Match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
    expect((await s.browser.call('GET', `${s.base}/${inv.id}`)).json()).toMatchObject({
      paid_amount: '0.00',
    })
  })
})
