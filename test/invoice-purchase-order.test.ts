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

/** A company with two suppliers, a sent and a received order to the first, a draft one. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, params: unknown[] = [company.id]) =>
    (await ctx.owner.query<{ id: string }>(sql, params)).rows[0]?.id ?? ''
  const supplier = await one(
    "insert into public.suppliers (company_id, name) values ($1, 'Edilmateriali') returning id",
  )
  const otherSupplier = await one(
    "insert into public.suppliers (company_id, name) values ($1, 'Noli Nord') returning id",
  )
  const client = await one(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
  )
  const order = (seq: number, status: string, supplierId = supplier) =>
    one(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         order_date, status, sent_at, received_at)
       values ($1, 2026, $2, $3, '2026-10-20', $4,
         case when $4 <> 'draft' then now() end, case when $4 = 'received' then now() end)
       returning id`,
      [company.id, seq, supplierId, status],
    )
  const sent = await order(1, 'sent')
  const received = await order(2, 'received')
  const draft = await order(3, 'draft')
  const otherOrder = await order(4, 'sent', otherSupplier)
  const invoice = (overrides: Record<string, unknown> = {}) => ({
    direction: 'received',
    number: `${Math.floor(Math.random() * 1_000_000)}/2026`,
    date: '2026-11-02',
    client_id: null,
    supplier_id: supplier,
    site_id: null,
    description: 'Cemento',
    taxable_amount: '1000.00',
    vat_amount: '220.00',
    due_date: null,
    paid_on: null,
    notes: null,
    purchase_order_id: sent,
    ...overrides,
  })
  return {
    browser,
    company,
    client,
    supplier,
    otherSupplier,
    sent,
    received,
    draft,
    otherOrder,
    invoice,
    base: `/api/companies/${company.slug}/invoices`,
  }
}

type Invoice = { id: string; purchase_order_id: string | null }

describe('received invoice of a purchase order', () => {
  it('links a received invoice to a sent or received order, several invoices per order', async () => {
    const s = await scene()
    const first = await s.browser.call('POST', s.base, { body: s.invoice() })
    expect(first.statusCode).toBe(201)
    expect(first.json<Invoice>().purchase_order_id).toBe(s.sent)
    const second = await s.browser.call('POST', s.base, { body: s.invoice() })
    expect(second.statusCode).toBe(201)
    const third = await s.browser.call('POST', s.base, {
      body: s.invoice({ purchase_order_id: s.received }),
    })
    expect(third.statusCode).toBe(201)
    const read = await s.browser.call('GET', `${s.base}/${first.json<Invoice>().id}`)
    expect(read.json<Invoice>().purchase_order_id).toBe(s.sent)
  })

  it('without the field the invoice has no order', async () => {
    const s = await scene()
    const body: Record<string, unknown> = s.invoice()
    delete body.purchase_order_id
    const res = await s.browser.call('POST', s.base, { body })
    expect(res.statusCode).toBe(201)
    expect(res.json<Invoice>().purchase_order_id).toBeNull()
  })

  it('refuses a draft order, an order of another supplier, an issued invoice, a bad id', async () => {
    const s = await scene()
    const cases: [Record<string, unknown>, string][] = [
      [{ purchase_order_id: s.draft }, 'Si collega solo un ordine già inviato al fornitore.'],
      [{ purchase_order_id: s.otherOrder }, "L'ordine è di un altro fornitore."],
      [{ purchase_order_id: '00000000-0000-4000-8000-000000000000' }, 'Ordine non trovato.'],
      [{ purchase_order_id: 'abc' }, 'Ordine non trovato.'],
      [
        { direction: 'issued', client_id: s.client, supplier_id: null },
        'Si collega un ordine solo a una fattura ricevuta.',
      ],
    ]
    for (const [overrides, message] of cases) {
      const res = await s.browser.call('POST', s.base, { body: s.invoice(overrides) })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ errors: { purchase_order_id: [message] } })
    }
    const count = await ctx.owner.query('select 1 from public.invoices where company_id = $1', [
      s.company.id,
    ])
    expect(count.rowCount).toBe(0)
  })

  it('keeps the link when absent on update, checks it again, removes it with null', async () => {
    const s = await scene()
    const created = (await s.browser.call('POST', s.base, { body: s.invoice() })).json<
      Invoice & { number: string }
    >()
    const url = `${s.base}/${created.id}`
    const body: Record<string, unknown> = s.invoice({ number: created.number })
    delete body.purchase_order_id
    const kept = await s.browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(kept.statusCode).toBe(200)
    expect(kept.json<Invoice>().purchase_order_id).toBe(s.sent)
    // Changing the supplier while the order stays linked is refused.
    const moved = await s.browser.call('PUT', url, {
      body: { ...body, supplier_id: s.otherSupplier },
      headers: { 'if-match': '"2"' },
    })
    expect(moved.statusCode).toBe(422)
    expect(Object.keys(moved.json<{ errors: object }>().errors)).toEqual(['purchase_order_id'])
    const removed = await s.browser.call('PUT', url, {
      body: s.invoice({ number: created.number, purchase_order_id: null }),
      headers: { 'if-match': '"2"' },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json<Invoice>().purchase_order_id).toBeNull()
  })

  it('filters the register and the CSV by order', async () => {
    const s = await scene()
    const a = (await s.browser.call('POST', s.base, { body: s.invoice() })).json<Invoice>()
    await s.browser.call('POST', s.base, { body: s.invoice({ purchase_order_id: s.received }) })
    await s.browser.call('POST', s.base, { body: s.invoice({ purchase_order_id: null }) })
    const list = await s.browser.call('GET', `${s.base}?filter[purchase_order]=${s.sent}`)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Invoice[] }>().data.map((i) => i.id)).toEqual([a.id])
    const csv = await s.browser.call('GET', `${s.base}/export?filter[purchase_order]=${s.sent}`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\n')).toHaveLength(2)
    const bad = await s.browser.call('GET', `${s.base}?filter[purchase_order]=abc`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ errors: { 'filter[purchase_order]': [expect.any(String)] } })
  })

  it('finds the received invoices without an order, in the register and the CSV', async () => {
    const s = await scene()
    const linked = (await s.browser.call('POST', s.base, { body: s.invoice() })).json<Invoice>()
    const loose = (
      await s.browser.call('POST', s.base, { body: s.invoice({ purchase_order_id: null }) })
    ).json<Invoice>()
    const issued = (
      await s.browser.call('POST', s.base, {
        body: s.invoice({
          direction: 'issued',
          client_id: s.client,
          supplier_id: null,
          purchase_order_id: null,
        }),
      })
    ).json<Invoice>()
    const other = await scene()
    await other.browser.call('POST', other.base, {
      body: other.invoice({ purchase_order_id: null }),
    })
    const ids = async (query: string) => {
      const res = await s.browser.call('GET', `${s.base}?sort=date&${query}`)
      expect(res.statusCode).toBe(200)
      return res
        .json<{ data: Invoice[] }>()
        .data.map((i) => i.id)
        .sort()
    }
    expect(await ids('filter[direction]=received&filter[has_purchase_order]=false')).toEqual([
      loose.id,
    ])
    expect(await ids('filter[has_purchase_order]=false')).toEqual([loose.id, issued.id].sort())
    expect(await ids('filter[has_purchase_order]=true')).toEqual([linked.id])
    const csv = await s.browser.call(
      'GET',
      `${s.base}/export?filter[direction]=received&filter[has_purchase_order]=false`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\n')).toHaveLength(2)
    const bad = await s.browser.call('GET', `${s.base}?filter[has_purchase_order]=no`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({
      errors: { 'filter[has_purchase_order]': ['Valori ammessi: true, false.'] },
    })
    const badCsv = await s.browser.call('GET', `${s.base}/export?filter[has_purchase_order]=1`)
    expect(badCsv.statusCode).toBe(422)
  })

  it('an order of another company is not found', async () => {
    const s = await scene()
    const other = await scene()
    const res = await s.browser.call('POST', s.base, {
      body: s.invoice({ purchase_order_id: other.sent }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { purchase_order_id: ['Ordine non trovato.'] } })
  })

  it('a company with a billed order can still be deleted', async () => {
    const s = await scene()
    expect((await s.browser.call('POST', s.base, { body: s.invoice() })).statusCode).toBe(201)
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query(
      'select 1 from public.purchase_orders where company_id = $1',
      [s.company.id],
    )
    expect(left.rowCount).toBe(0)
  })

  it('shows the invoiced amount in the order, only to who sees invoices', async () => {
    const s = await scene([...ALL, 'purchases.view'])
    const orders = `/api/companies/${s.company.slug}/purchase-orders`
    type Order = { id: string; invoiced_amount: string | null }
    await s.browser.call('POST', s.base, { body: s.invoice({ taxable_amount: '0.10' }) })
    await s.browser.call('POST', s.base, { body: s.invoice({ taxable_amount: '0.20' }) })
    await s.browser.call('POST', s.base, { body: s.invoice({ purchase_order_id: null }) })
    const one = await s.browser.call('GET', `${orders}/${s.sent}`)
    expect(one.statusCode).toBe(200)
    expect(one.json<Order>().invoiced_amount).toBe('0.30')
    const etag = one.headers.etag
    const list = await s.browser.call('GET', `${orders}?sort=number`)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Order[] }>().data.map((o) => o.invoiced_amount)).toEqual([
      '0.30',
      '0.00',
      '0.00',
      '0.00',
    ])
    expect((await s.browser.call('GET', `${orders}/${s.sent}`)).headers.etag).toBe(etag)
    const csv = await s.browser.call('GET', `${orders}/export?sort=number`)
    const rows = csv.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(rows[0]?.endsWith(';Fatturato;CIG;CUP')).toBe(true)
    expect(rows[1]?.endsWith(';0,30;;')).toBe(true)

    const blind = new Browser(ctx.app)
    const buyer = await fx.user()
    await fx.member(
      buyer.id,
      s.company.id,
      await fx.role(s.company.id, 'Acquisti', ['purchases.view']),
    )
    await blind.signIn(buyer.email)
    const hidden = await blind.call('GET', `${orders}/${s.sent}`)
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json<Order>().invoiced_amount).toBeNull()
    const hiddenList = await blind.call('GET', orders)
    expect(hiddenList.json<{ data: Order[] }>().data.every((o) => o.invoiced_amount === null)).toBe(
      true,
    )
    const hiddenCsv = await blind.call('GET', `${orders}/export?sort=number`)
    const hiddenRows = hiddenCsv.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(hiddenRows[1]?.endsWith(';')).toBe(true)
  })

  it('filters the orders by invoiced, only for who sees invoices', async () => {
    const s = await scene([...ALL, 'purchases.view'])
    const orders = `/api/companies/${s.company.slug}/purchase-orders`
    await s.browser.call('POST', s.base, { body: s.invoice() })
    const ids = async (query: string) =>
      (await s.browser.call('GET', `${orders}?sort=number&${query}`))
        .json<{ data: { id: string }[] }>()
        .data.map((o) => o.id)
    expect(await ids('filter[invoiced]=true')).toEqual([s.sent])
    expect(await ids('filter[invoiced]=false')).toEqual([s.received, s.draft, s.otherOrder])
    expect(await ids('filter[invoiced]=false&filter[status]=received')).toEqual([s.received])
    const csv = await s.browser.call('GET', `${orders}/export?filter[invoiced]=true`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\r\n')).toHaveLength(2)
    const bad = await s.browser.call('GET', `${orders}?filter[invoiced]=si`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ errors: { 'filter[invoiced]': [expect.any(String)] } })

    const blind = new Browser(ctx.app)
    const buyer = await fx.user()
    await fx.member(
      buyer.id,
      s.company.id,
      await fx.role(s.company.id, 'Acquisti', ['purchases.view']),
    )
    await blind.signIn(buyer.email)
    expect((await blind.call('GET', `${orders}?filter[invoiced]=false`)).statusCode).toBe(403)
    expect((await blind.call('GET', `${orders}/export?filter[invoiced]=true`)).statusCode).toBe(403)
    expect((await blind.call('GET', orders)).statusCode).toBe(200)
  })
  it('shows the order number in the invoice and in the CSV, ignored in the body', async () => {
    const s = await scene()
    // Numbers beyond 999 keep all their digits.
    const big = await ctx.owner.query<{ id: string }>(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         order_date, status, sent_at) values ($1, 2026, 1234, $2, '2026-10-20', 'sent', now())
       returning id`,
      [s.company.id, s.supplier],
    )
    const bigId = big.rows[0]?.id ?? ''
    const created = await s.browser.call('POST', s.base, {
      body: { ...s.invoice({ number: 'A/1' }), purchase_order: { id: bigId, number: '9/9' } },
    })
    expect(created.statusCode).toBe(201)
    const invoice = created.json<{ id: string; purchase_order: unknown }>()
    expect(invoice.purchase_order).toEqual({ id: s.sent, number: '2026/001' })
    const other = await s.browser.call('POST', s.base, {
      body: s.invoice({ number: 'A/2', purchase_order_id: bigId }),
    })
    expect(other.json<{ purchase_order: unknown }>().purchase_order).toEqual({
      id: bigId,
      number: '2026/1234',
    })
    const none = await s.browser.call('POST', s.base, {
      body: s.invoice({ number: 'A/3', purchase_order_id: null }),
    })
    expect(none.json<{ purchase_order: unknown }>().purchase_order).toBeNull()
    const read = await s.browser.call('GET', `${s.base}/${invoice.id}`)
    expect(read.json<{ purchase_order: unknown }>().purchase_order).toEqual({
      id: s.sent,
      number: '2026/001',
    })

    const csv = await s.browser.call('GET', `${s.base}/export?sort=date`)
    expect(csv.statusCode).toBe(200)
    const rows = csv.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(rows[0]?.endsWith(';Note;Ordine;Documento;Fattura stornata;CIG;CUP')).toBe(true)
    const byNumber = (n: string) => rows.find((r) => r.split(';')[1] === n) ?? ''
    expect(byNumber('A/1').endsWith(';2026/001;Fattura;;;')).toBe(true)
    expect(byNumber('A/2').endsWith(';2026/1234;Fattura;;;')).toBe(true)
    expect(byNumber('A/3').endsWith(';;Fattura;;;')).toBe(true)
  })
  it('filters the orders invoiced over their total, only for who sees invoices', async () => {
    const s = await scene([...ALL, 'purchases.view'])
    const orders = `/api/companies/${s.company.slug}/purchase-orders`
    const line = (orderId: string, quantity: string, cents: number) =>
      ctx.owner.query(
        `insert into public.purchase_order_lines (company_id, order_id, position, description,
           quantity, unit_price_cents) values ($1, $2, 0, 'Cemento', $3, $4)`,
        [s.company.id, orderId, quantity, cents],
      )
    // Sent: 1000.00 ordered, two invoices of 500.00 and 500.00: equal, not over.
    await line(s.sent, '2.5', 40000)
    for (const taxable of ['500.00', '500.00']) {
      await s.browser.call('POST', s.base, { body: s.invoice({ taxable_amount: taxable }) })
    }
    // Received: 1000.00 ordered, billed 1000.01: over by one cent.
    await line(s.received, '1', 100000)
    await s.browser.call('POST', s.base, {
      body: s.invoice({ purchase_order_id: s.received, taxable_amount: '1000.01' }),
    })
    // The other supplier's order has no lines and no invoices: not over.
    const ids = async (query: string) => {
      const res = await s.browser.call('GET', `${orders}?sort=number&${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: { id: string }[] }>().data.map((o) => o.id)
    }
    expect(await ids('filter[over_invoiced]=true')).toEqual([s.received])
    expect(await ids('filter[over_invoiced]=false')).toEqual([s.sent, s.draft, s.otherOrder])
    expect(await ids('filter[over_invoiced]=true&filter[status]=sent')).toEqual([])
    const csv = await s.browser.call('GET', `${orders}/export?filter[over_invoiced]=true`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\r\n')).toHaveLength(2)
    const bad = await s.browser.call('GET', `${orders}?filter[over_invoiced]=1`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ errors: { 'filter[over_invoiced]': [expect.any(String)] } })

    const blind = new Browser(ctx.app)
    const buyer = await fx.user()
    await fx.member(
      buyer.id,
      s.company.id,
      await fx.role(s.company.id, 'Acquisti', ['purchases.view']),
    )
    await blind.signIn(buyer.email)
    expect((await blind.call('GET', `${orders}?filter[over_invoiced]=false`)).statusCode).toBe(403)
    expect(
      (await blind.call('GET', `${orders}/export?filter[over_invoiced]=true`)).statusCode,
    ).toBe(403)
  })
})
