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
  const other = await insert(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Anna Verdi') returning id",
  )
  const root = `/api/companies/${company.slug}`
  return { browser, client, other, root, base: `${root}/invoices` }
}

type Scene = Awaited<ReturnType<typeof scene>>

type Invoice = {
  id: string
  number: string
  total: string
  amount_due: string
  remaining_amount: string
  credited_amount: string
  payment_status: string
  document_type: string
  credited_invoice_id: string | null
  credited_invoice: { id: string; number: string } | null
  paid_on: string | null
  deadline_id: string | null
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

async function create(s: Scene, overrides: Record<string, unknown> = {}) {
  const res = await s.browser.call('POST', s.base, { body: body(s, overrides) })
  expect(res.statusCode).toBe(201)
  return res.json<Invoice>()
}

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

async function get(s: Scene, id: string) {
  return (await s.browser.call('GET', `${s.base}/${id}`)).json<Invoice>()
}

describe('credit notes', () => {
  it('count with the minus sign in totals, balances and VAT, and lower what is left', async () => {
    const s = await scene()
    const inv = await create(s, { number: '12/2026' })
    const res = await s.browser.call('POST', s.base, { body: note(s, inv.id) })
    expect(res.statusCode).toBe(201)
    expect(res.json<Invoice>()).toMatchObject({
      document_type: 'credit_note',
      credited_invoice_id: inv.id,
      credited_invoice: { id: inv.id, number: '12/2026' },
      total: '244.00',
      amount_due: '-244.00',
      remaining_amount: '0.00',
      credited_amount: '0.00',
      payment_status: 'paid',
      deadline_id: null,
    })
    const after = await get(s, inv.id)
    expect(after).toMatchObject({
      document_type: 'invoice',
      credited_invoice: null,
      credited_amount: '244.00',
      amount_due: '1220.00',
      remaining_amount: '976.00',
      payment_status: 'open',
    })
    const deadline = await s.browser.call('GET', `${s.root}/deadlines/${after.deadline_id}`)
    expect(deadline.json<{ amount: string }>().amount).toBe('976.00')

    const list = await s.browser.call('GET', s.base)
    expect(list.json()).toMatchObject({ total_amount: '976.00', outstanding_amount: '976.00' })
    const account = await s.browser.call('GET', `${s.root}/clients/${s.client}/account`)
    expect(account.statusCode).toBe(200)
    expect(account.json()).toMatchObject({ invoice_count: 1, open_invoice_count: 1 })
    const vat = await s.browser.call('GET', `${s.root}/vat-summary?year=2026`)
    const november = vat
      .json<{ periods: { period: string; sales_taxable: string; sales_vat: string }[] }>()
      .periods.find((p) => p.period === '2026-11')
    expect(november).toMatchObject({ sales_taxable: '800.00', sales_vat: '176.00' })

    // 0.10 + 0.20 paid, then the rest: the payments stop at what the note left.
    const pay = (amount: string, version: number) =>
      s.browser.call('POST', `${s.base}/${inv.id}/payments`, {
        headers: { 'If-Match': `"${version}"` },
        body: { date: '2026-11-25', amount, method: null, notes: null },
      })
    expect((await pay('976.01', 2)).statusCode).toBe(422)
    expect((await pay('0.10', 2)).statusCode).toBe(200)
    expect((await pay('0.20', 3)).statusCode).toBe(200)
    const paid = await pay('975.70', 4)
    expect(paid.statusCode).toBe(200)
    expect(paid.json<Invoice>()).toMatchObject({
      remaining_amount: '0.00',
      paid_on: '2026-11-25',
      payment_status: 'paid',
    })
    const noteId = res.json<Invoice>().id
    const onNote = await s.browser.call('POST', `${s.base}/${noteId}/payments`, {
      headers: { 'If-Match': '"1"' },
      body: { date: '2026-11-25', amount: '1', method: null, notes: null },
    })
    expect(onNote.statusCode).toBe(409)
    expect(onNote.json<{ code: string }>().code).toBe('credit_note')
  })

  it('a note covering the whole invoice settles it and closes its deadline', async () => {
    const s = await scene()
    const inv = await create(s)
    const res = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { taxable_amount: '1000', vat_amount: '220' }),
    })
    expect(res.statusCode).toBe(201)
    const after = await get(s, inv.id)
    expect(after).toMatchObject({ remaining_amount: '0.00', payment_status: 'paid' })
    const deadline = await s.browser.call('GET', `${s.root}/deadlines/${after.deadline_id}`)
    expect(deadline.json<{ status: string }>().status).toBe('done')
    const list = await s.browser.call('GET', `${s.base}?filter[status]=open`)
    expect(list.json()).toMatchObject({ meta: { total: 0 }, outstanding_amount: '0.00' })

    // Deleting the note opens the invoice again; an invoice with notes is not deleted.
    const blocked = await s.browser.call('DELETE', `${s.base}/${inv.id}`, {
      headers: { 'If-Match': '"2"' },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json<{ code: string }>().code).toBe('has_documents')
    const removed = await s.browser.call('DELETE', `${s.base}/${res.json<Invoice>().id}`, {
      headers: { 'If-Match': '"1"' },
    })
    expect(removed.statusCode).toBe(204)
    expect(await get(s, inv.id)).toMatchObject({
      remaining_amount: '1220.00',
      credited_amount: '0.00',
      payment_status: 'open',
    })
    const reopened = await s.browser.call('GET', `${s.root}/deadlines/${after.deadline_id}`)
    expect(reopened.json<{ status: string }>().status).toBe('open')
  })

  it('a note alone in a period makes the VAT of the period negative', async () => {
    const s = await scene()
    const inv = await create(s)
    const res = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { date: '2026-12-03', taxable_amount: '0.10', vat_amount: '0.20' }),
    })
    expect(res.statusCode).toBe(201)
    const vat = await s.browser.call('GET', `${s.root}/vat-summary?year=2026`)
    const december = vat
      .json<{ periods: { period: string; sales_taxable: string; sales_vat: string }[] }>()
      .periods.find((p) => p.period === '2026-12')
    expect(december).toMatchObject({ sales_taxable: '-0.10', sales_vat: '-0.20' })
    const list = await s.browser.call('GET', `${s.base}?filter[from]=2026-12-01`)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ total_amount: string }>().total_amount).toBe('-0.30')
  })

  it('refuses notes that do not fit their invoice', async () => {
    const s = await scene()
    const inv = await create(s)
    const fail = async (overrides: Record<string, unknown>, field: string, credited = inv.id) => {
      const res = await s.browser.call('POST', s.base, { body: note(s, credited, overrides) })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
    }
    await fail({ taxable_amount: '1000', vat_amount: '220.01' }, 'taxable_amount')
    await fail({ taxable_amount: '1000.01', vat_amount: '0' }, 'taxable_amount')
    await fail({ taxable_amount: '0', vat_amount: '220.01' }, 'vat_amount')
    await fail({ due_date: '2026-12-31' }, 'due_date')
    await fail({ paid_on: '2026-12-31' }, 'paid_on')
    await fail({ split_payment: true }, 'split_payment')
    await fail({ withholding_amount: '10' }, 'withholding_amount')
    await fail({ credited_invoice_id: null }, 'credited_invoice_id')
    await fail({ client_id: s.other }, 'credited_invoice_id')
    await fail({ document_type: 'TD04' }, 'document_type')
    await fail({ document_type: 'invoice' }, 'credited_invoice_id')
    // An invoice of another company is not found.
    const stranger = await scene()
    const theirs = await create(stranger)
    await fail({}, 'credited_invoice_id', theirs.id)
    // A note does not credit another note; two notes stay within the invoice.
    const first = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { taxable_amount: '900', vat_amount: '200' }),
    })
    expect(first.statusCode).toBe(201)
    await fail({}, 'credited_invoice_id', first.json<Invoice>().id)
    await fail({ taxable_amount: '100', vat_amount: '20.01' }, 'taxable_amount')
    const second = await s.browser.call('POST', s.base, {
      body: note(s, inv.id, { taxable_amount: '100', vat_amount: '20' }),
    })
    expect(second.statusCode).toBe(201)
    expect(await get(s, inv.id)).toMatchObject({ remaining_amount: '0.00', payment_status: 'paid' })
  })

  it('an invoice with notes keeps its client, and the type never changes', async () => {
    const s = await scene()
    const inv = await create(s)
    const res = await s.browser.call('POST', s.base, { body: note(s, inv.id) })
    expect(res.statusCode).toBe(201)
    const put = (id: string, version: number, overrides: Record<string, unknown>) =>
      s.browser.call('PUT', `${s.base}/${id}`, {
        headers: { 'If-Match': `"${version}"` },
        body: body(s, overrides),
      })
    expect((await put(inv.id, 2, { client_id: s.other })).statusCode).toBe(422)
    expect((await put(inv.id, 2, { taxable_amount: '100', vat_amount: '22' })).statusCode).toBe(422)
    expect((await put(inv.id, 2, { document_type: 'credit_note' })).statusCode).toBe(422)
    const changed = await put(inv.id, 2, { description: 'Lavori extra' })
    expect(changed.headers.etag).toBe('"3"')
    expect(changed.statusCode).toBe(200)
    expect(changed.json<Invoice>().remaining_amount).toBe('976.00')
    // The note itself: amounts change within the invoice, the type stays.
    const noteId = res.json<Invoice>().id
    const fields = note(s, inv.id)
    const edited = await s.browser.call('PUT', `${s.base}/${noteId}`, {
      headers: { 'If-Match': '"1"' },
      body: {
        ...fields,
        credited_invoice_id: undefined,
        document_type: undefined,
        vat_amount: '0',
      },
    })
    expect(edited.statusCode).toBe(200)
    expect(edited.json<Invoice>()).toMatchObject({
      document_type: 'credit_note',
      amount_due: '-200.00',
    })
    expect((await get(s, inv.id)).remaining_amount).toBe('1020.00')
  })

  it('lists only the credit notes, or the notes of one invoice, also in the CSV', async () => {
    const s = await scene()
    const first = await create(s, { number: '1/2026' })
    const second = await create(s, { number: '2/2026' })
    const a = await s.browser.call('POST', s.base, {
      body: note(s, first.id, { number: 'NC-1', taxable_amount: '0.10', vat_amount: '0' }),
    })
    const b = await s.browser.call('POST', s.base, {
      body: note(s, second.id, { number: 'NC-2', taxable_amount: '0.20', vat_amount: '0' }),
    })
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    const notes = await s.browser.call('GET', `${s.base}?filter[document_type]=credit_note`)
    expect(notes.statusCode).toBe(200)
    expect(notes.json()).toMatchObject({ meta: { total: 2 }, total_amount: '-0.30' })
    const invoices = await s.browser.call('GET', `${s.base}?filter[document_type]=invoice`)
    expect(invoices.json()).toMatchObject({ meta: { total: 2 }, total_amount: '2440.00' })
    const ofFirst = await s.browser.call('GET', `${s.base}?filter[credited_invoice]=${first.id}`)
    expect(ofFirst.json<{ data: Invoice[] }>().data.map((i) => i.number)).toEqual(['NC-1'])
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?filter[document_type]=credit_note&sort=date`,
    )
    expect(csv.statusCode).toBe(200)
    const rows = csv.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(rows.slice(1).map((r) => r.split(';').slice(-2).join(';'))).toEqual([
      'Nota di credito;1/2026',
      'Nota di credito;2/2026',
    ])
    // Another company's invoice: an empty list, not its notes.
    const stranger = await scene()
    const theirs = await create(stranger)
    const res = await stranger.browser.call('POST', stranger.base, {
      body: note(stranger, theirs.id),
    })
    expect(res.statusCode).toBe(201)
    const empty = await s.browser.call('GET', `${s.base}?filter[credited_invoice]=${theirs.id}`)
    expect(empty.json()).toMatchObject({ meta: { total: 0 }, total_amount: '0.00' })
    for (const bad of [
      'filter[document_type]=TD04',
      'filter[document_type]=constructor',
      'filter[document_type]=invoice&filter[document_type]=credit_note',
      'filter[credited_invoice]=x',
    ]) {
      expect((await s.browser.call('GET', `${s.base}?${bad}`)).statusCode).toBe(422)
      expect((await s.browser.call('GET', `${s.base}/export?${bad}`)).statusCode).toBe(422)
    }
  })
})
