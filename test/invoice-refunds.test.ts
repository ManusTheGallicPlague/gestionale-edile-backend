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
  'invoices.view',
  'invoices.create',
  'invoices.update',
  'invoices.delete',
  'deadlines.view',
]

async function scene() {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Amministrazione', ALL))
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
  const root = `/api/companies/${company.slug}`
  return { browser, client, supplier, root, base: `${root}/invoices` }
}

type Scene = Awaited<ReturnType<typeof scene>>

type Invoice = {
  id: string
  total: string
  amount_due: string
  paid_amount: string
  remaining_amount: string
  credited_amount: string
  refund: boolean
  refund_due_amount: string
  payment_status: string
  paid_on: string | null
}

const body = (s: Scene, overrides: Record<string, unknown> = {}) => ({
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
})

const note = (s: Scene, credited: string, overrides: Record<string, unknown> = {}) =>
  body(s, {
    document_type: 'credit_note',
    credited_invoice_id: credited,
    number: `NC-${Math.random().toString(36).slice(2, 8)}`,
    date: '2026-11-20',
    taxable_amount: '200',
    vat_amount: '44',
    due_date: null,
    ...overrides,
  })

async function create(s: Scene, payload: Record<string, unknown>) {
  const res = await s.browser.call('POST', s.base, { body: payload })
  expect(res.statusCode).toBe(201)
  return res.json<Invoice>()
}

const get = async (s: Scene, id: string) =>
  (await s.browser.call('GET', `${s.base}/${id}`)).json<Invoice & { version?: number }>()

const version = async (s: Scene, id: string) =>
  (await s.browser.call('GET', `${s.base}/${id}`)).headers.etag as string

const pay = async (s: Scene, id: string, amount: string, date = '2026-11-10') =>
  s.browser.call('POST', `${s.base}/${id}/payments`, {
    headers: { 'If-Match': await version(s, id) },
    body: { date, amount, method: 'bank_transfer', notes: null },
  })

/** An invoice of 1220.00 paid in full on 10/11/2026 by one payment. */
async function paidInvoice(s: Scene, overrides: Record<string, unknown> = {}) {
  const inv = await create(s, body(s, overrides))
  const res = await pay(s, inv.id, '1220')
  expect(res.statusCode).toBe(200)
  expect(res.json<Invoice>().paid_on).toBe('2026-11-10')
  return inv
}

describe('refunds on credit notes', () => {
  it('a note on a paid invoice is refunded with payments counted with the minus', async () => {
    const s = await scene()
    const inv = await paidInvoice(s)
    const created = await create(s, note(s, inv.id))
    expect(created).toMatchObject({
      refund: true,
      refund_due_amount: '244.00',
      paid_amount: '0.00',
      remaining_amount: '0.00',
      payment_status: 'paid',
    })
    // The invoice stays paid: nothing is left to pay, the money goes back.
    expect(await get(s, inv.id)).toMatchObject({
      paid_on: '2026-11-10',
      paid_amount: '1220.00',
      remaining_amount: '0.00',
      credited_amount: '244.00',
      payment_status: 'paid',
    })

    // 0.10 + 0.20 refunded: -0.30 paid on the note, 243.70 still to refund.
    expect((await pay(s, created.id, '0.10', '2026-11-21')).statusCode).toBe(200)
    const second = await pay(s, created.id, '0.20', '2026-11-22')
    expect(second.statusCode).toBe(200)
    expect(second.json<Invoice>()).toMatchObject({
      paid_amount: '-0.30',
      refund_due_amount: '243.70',
      remaining_amount: '0.00',
    })
    const over = await pay(s, created.id, '243.71')
    expect(over.statusCode).toBe(422)
    expect(Object.keys(over.json<{ errors: object }>().errors)).toEqual(['amount'])

    const own = await s.browser.call('GET', `${s.base}/${created.id}/payments`)
    expect(own.json<{ data: { amount: string }[] }>().data.map((p) => p.amount)).toEqual([
      '-0.10',
      '-0.20',
    ])

    // Prima nota: the refunds lower what was collected; alone in a period, it is negative.
    const journal = `${s.root}/invoice-payments`
    const all = await s.browser.call('GET', journal)
    expect(all.json()).toMatchObject({ collected: '1219.70', paid: '0.00' })
    const late = await s.browser.call('GET', `${journal}?filter[from]=2026-11-21`)
    expect(late.json()).toMatchObject({ meta: { total: 2 }, collected: '-0.30' })
    const csv = await s.browser.call('GET', `${journal}/export?filter[from]=2026-11-22`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('22/11/2026;Rimborso fatto;')
    expect(csv.body).toContain(';-0,20;Bonifico;')

    // A refund deleted goes back to be refunded.
    const listed = own.json<{ data: { id: string }[] }>().data
    const removed = await s.browser.call(
      'DELETE',
      `${s.base}/${created.id}/payments/${listed[0]?.id}`,
      { headers: { 'If-Match': await version(s, created.id) } },
    )
    expect(removed.statusCode).toBe(200)
    expect(removed.json<Invoice>()).toMatchObject({
      paid_amount: '-0.20',
      refund_due_amount: '243.80',
    })
  })

  it('a refund received from a supplier counts with the minus in the payments', async () => {
    const s = await scene()
    const inv = await paidInvoice(s, {
      direction: 'received',
      client_id: null,
      supplier_id: s.supplier,
    })
    const created = await create(
      s,
      note(s, inv.id, { direction: 'received', client_id: null, supplier_id: s.supplier }),
    )
    expect(created.refund).toBe(true)
    expect((await pay(s, created.id, '244', '2026-11-30')).statusCode).toBe(200)
    expect(await get(s, created.id)).toMatchObject({
      paid_amount: '-244.00',
      refund_due_amount: '0.00',
    })
    const journal = await s.browser.call('GET', `${s.root}/invoice-payments`)
    expect(journal.json()).toMatchObject({ collected: '0.00', paid: '976.00' })
    const csv = await s.browser.call('GET', `${s.root}/invoice-payments/export`)
    expect(csv.body).toContain('30/11/2026;Rimborso ricevuto;')
    // Nothing more to refund.
    expect((await pay(s, created.id, '0.01')).statusCode).toBe(422)
  })

  it('a note written before the payment has no refunds', async () => {
    const s = await scene()
    const inv = await create(s, body(s))
    const created = await create(s, note(s, inv.id))
    expect(created).toMatchObject({ refund: false, refund_due_amount: '0.00' })
    expect((await pay(s, inv.id, '976')).statusCode).toBe(200)
    const res = await pay(s, created.id, '1')
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('credit_note')
    // Paid with the note: the invoice is paid, and a new note is a refund note.
    expect(await get(s, inv.id)).toMatchObject({ paid_on: '2026-11-10', remaining_amount: '0.00' })
    const refund = await create(s, note(s, inv.id, { taxable_amount: '0.10', vat_amount: '0.20' }))
    expect(refund).toMatchObject({ refund: true, refund_due_amount: '0.30' })
  })

  it('a refund note stays within what was paid, and the invoice stays paid', async () => {
    const s = await scene()
    // Withholding of 100.00: 1120.00 paid on a total of 1220.00.
    const inv = await create(s, body(s, { withholding_amount: '100' }))
    expect((await pay(s, inv.id, '1120')).statusCode).toBe(200)
    const tooMuch = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { taxable_amount: '1000', vat_amount: '220' }),
    })
    expect(tooMuch.statusCode).toBe(422)
    expect(Object.keys(tooMuch.json<{ errors: object }>().errors)).toEqual(['taxable_amount'])
    const first = await create(s, note(s, inv.id, { taxable_amount: '900', vat_amount: '200' }))
    expect(first.refund_due_amount).toBe('1100.00')
    // 20.01 more would pass what was paid (1120.00 - 1100.00).
    const second = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { taxable_amount: '0.01', vat_amount: '20' }),
    })
    expect(second.statusCode).toBe(422)
    await create(s, note(s, inv.id, { taxable_amount: '0', vat_amount: '20' }))

    // The payment of the invoice cannot go: the refund notes need it paid.
    const payments = await s.browser.call('GET', `${s.base}/${inv.id}/payments`)
    const paymentId = payments.json<{ data: { id: string }[] }>().data[0]?.id
    const removed = await s.browser.call('DELETE', `${s.base}/${inv.id}/payments/${paymentId}`, {
      headers: { 'If-Match': await version(s, inv.id) },
    })
    expect(removed.statusCode).toBe(409)
    expect(removed.json<{ code: string }>().code).toBe('has_documents')
    expect(await get(s, inv.id)).toMatchObject({ paid_on: '2026-11-10', paid_amount: '1120.00' })

    // Raising the invoice would leave it not paid: refused.
    const raised = await s.browser.call('PUT', `${s.base}/${inv.id}`, {
      headers: { 'If-Match': await version(s, inv.id) },
      body: body(s, { taxable_amount: '2000', vat_amount: '440', withholding_amount: '100' }),
    })
    expect(raised.statusCode).toBe(422)
    expect(await get(s, inv.id)).toMatchObject({ paid_on: '2026-11-10', amount_due: '1120.00' })
  })

  it('a refund note does not go below the refunds registered on it', async () => {
    const s = await scene()
    const inv = await paidInvoice(s)
    const payload = note(s, inv.id, { taxable_amount: '0.10', vat_amount: '0.20' })
    const created = await create(s, payload)
    expect((await pay(s, created.id, '0.30')).statusCode).toBe(200)
    const lower = await s.browser.call('PUT', `${s.base}/${created.id}`, {
      headers: { 'If-Match': await version(s, created.id) },
      body: { ...payload, vat_amount: '0.19' },
    })
    expect(lower.statusCode).toBe(422)
    expect(Object.keys(lower.json<{ errors: object }>().errors)).toEqual(['taxable_amount'])
    const higher = await s.browser.call('PUT', `${s.base}/${created.id}`, {
      headers: { 'If-Match': await version(s, created.id) },
      body: { ...payload, vat_amount: '0.21' },
    })
    expect(higher.statusCode).toBe(200)
    expect(higher.json<Invoice>()).toMatchObject({ refund: true, refund_due_amount: '0.01' })
  })

  it('a refund is not registered on a note of another company', async () => {
    const s = await scene()
    const stranger = await scene()
    const inv = await paidInvoice(stranger)
    const theirs = await create(stranger, note(stranger, inv.id))
    const res = await s.browser.call('POST', `${s.base}/${theirs.id}/payments`, {
      headers: { 'If-Match': '"1"' },
      body: { date: '2026-11-10', amount: '1', method: null, notes: null },
    })
    expect(res.statusCode).toBe(404)
    expect(await get(stranger, theirs.id)).toMatchObject({
      paid_amount: '0.00',
      refund_due_amount: '244.00',
    })
  })
})
