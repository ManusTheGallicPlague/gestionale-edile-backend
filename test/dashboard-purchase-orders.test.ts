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

/** A company with purchase orders in every state, and a user with the given permissions. */
async function scene(permissions: Permission[] = ['purchases.view']) {
  const { company } = await fx.companyWithUser(['purchases.view'])
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Dashboard', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const id = company.id
  const suppliers = await ctx.owner.query<{ id: string }>(
    "insert into public.suppliers (company_id, name) values ($1, 'Laterizi di prova') returning id",
    [id],
  )
  const supplierId = suppliers.rows[0]?.id
  let seq = 0
  /** An order dated 20 days ago, with the delivery `deliveryIn` days from today (or none). */
  const order = async (status: string, notes: string, deliveryIn: number | null) => {
    seq += 1
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         order_date, delivery_date, status, notes, sent_at, received_at)
       values ($1, 2026, $2, $3, (now() at time zone 'Europe/Rome')::date - 20,
         (now() at time zone 'Europe/Rome')::date + $4::int, $5, $6,
         case when $5 = 'draft' then null else now() end,
         case when $5 = 'received' then now() else null end)
       returning id`,
      [id, seq, supplierId, deliveryIn, status, notes],
    )
    return rows[0]?.id ?? ''
  }
  const line = (orderId: string, position: number, quantity: string, cents: number) =>
    ctx.owner.query(
      `insert into public.purchase_order_lines (company_id, order_id, position, description,
         quantity, unit_price_cents) values ($1, $2, $3, 'Mattoni', $4, $5)`,
      [id, orderId, position, quantity, cents],
    )

  await order('draft', 'Bozza', 3)
  // Lines rounded one by one: 1.5 × 333 = 499.5 → 500 cents, twice.
  const late = await order('sent', 'In ritardo', -2)
  await line(late, 0, '1.5', 333)
  await line(late, 1, '1.5', 333)
  await line(await order('sent', 'Oggi', 0), 0, '1', 10000) // Due today: due soon.
  await order('sent', 'Sette giorni', 7) // Due in 7 days: due soon, no lines.
  await line(await order('sent', 'Più avanti', 8), 0, '2', 50) // Not yet due soon.
  await line(await order('sent', 'Senza data', null), 0, '1', 99) // Only awaiting.
  const received = await order('received', 'Ricevuto', -5) // Not awaiting.
  await line(received, 0, '1', 77777)
  return {
    browser,
    company,
    supplierId,
    received,
    order,
    line,
    url: `/api/companies/${company.slug}/dashboard`,
  }
}

describe('purchase orders in the dashboard', () => {
  it('counts the orders to follow up, only of the company', async () => {
    const s = await scene()
    await scene() // Another company with the same orders must not double the counts.
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ purchase_orders: unknown }>().purchase_orders).toEqual({
      drafts: 1,
      awaiting: 5,
      awaiting_total: '111.99',
      late: 1,
      due_soon: 2,
      received_uninvoiced: null,
      received_uninvoiced_total: null,
      over_invoiced: null,
    })
  })

  it('is null without purchases.view, and zero for a company without orders', async () => {
    const blind = await scene(['sites.view'])
    expect(
      (await blind.browser.call('GET', blind.url)).json<{ purchase_orders: unknown }>()
        .purchase_orders,
    ).toBeNull()
    const { company } = await fx.companyWithUser(['purchases.view'])
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await fx.member(
      user.id,
      company.id,
      await fx.role(company.id, 'Vuota', ['purchases.view', 'invoices.view']),
    )
    const res = await browser.call('GET', `/api/companies/${company.slug}/dashboard`)
    expect(res.json<{ purchase_orders: unknown }>().purchase_orders).toEqual({
      drafts: 0,
      awaiting: 0,
      awaiting_total: '0.00',
      late: 0,
      due_soon: 0,
      received_uninvoiced: 0,
      received_uninvoiced_total: '0.00',
      over_invoiced: 0,
    })
  })

  it('counts the received orders without an invoice, with invoices.view', async () => {
    const s = await scene(['purchases.view', 'invoices.view'])
    await scene(['purchases.view', 'invoices.view']) // Another company must not count.
    // A second received order, invoiced: it leaves the count, whatever the invoiced amount.
    const invoiced = await s.order('received', 'Fatturato', -3)
    await s.line(invoiced, 0, '3', 1000)
    await ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         taxable_cents, vat_cents, purchase_order_id)
       values ($1, 'received', 'F/1', '2026-11-02', $2, 100, 22, $3)`,
      [s.company.id, s.supplierId, invoiced],
    )
    // A third received order without lines and without invoice: counted, worth zero.
    await s.order('received', 'Senza righe', -1)
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    const orders = res.json<{
      purchase_orders: { received_uninvoiced: number; received_uninvoiced_total: string }
    }>().purchase_orders
    expect(orders.received_uninvoiced).toBe(2)
    expect(orders.received_uninvoiced_total).toBe('777.77')
    // The invoiced order: 30.00 ordered, 1.00 billed, not over; then 29.01 more: over by 1 cent.
    expect(
      res.json<{ purchase_orders: { over_invoiced: number } }>().purchase_orders.over_invoiced,
    ).toBe(0)
    await ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         taxable_cents, vat_cents, purchase_order_id)
       values ($1, 'received', 'F/2', '2026-11-03', $2, 2901, 0, $3)`,
      [s.company.id, s.supplierId, invoiced],
    )
    const after = await s.browser.call('GET', s.url)
    expect(
      after.json<{ purchase_orders: { over_invoiced: number } }>().purchase_orders.over_invoiced,
    ).toBe(1)
    const over = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/purchase-orders?filter[over_invoiced]=true`,
    )
    expect(over.json<{ data: { notes: string }[] }>().data.map((o) => o.notes)).toEqual([
      'Fatturato',
    ])

    // The same orders as the list filtered by received and not invoiced.
    const list = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/purchase-orders?filter[status]=received&filter[invoiced]=false`,
    )
    expect(list.statusCode).toBe(200)
    const body = list.json<{ data: { notes: string }[]; total_amount: string }>()
    expect(body.data.map((o) => o.notes).sort()).toEqual(['Ricevuto', 'Senza righe'])
    expect(body.total_amount).toBe(orders.received_uninvoiced_total)
  })
})

describe('purchase orders to follow up in the list', () => {
  const notes = async (s: Awaited<ReturnType<typeof scene>>, query: string) => {
    const res = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/purchase-orders?${query}`,
    )
    expect(res.statusCode).toBe(200)
    return res.json<{ data: { notes: string }[]; total_amount: string }>()
  }

  it('filters the same orders the dashboard counts, by delivery date', async () => {
    const s = await scene()
    await scene()
    const byDelivery = 'sort=delivery_date&filter[follow_up]='
    const awaiting = await notes(s, `${byDelivery}awaiting`)
    expect(awaiting.data.map((o) => o.notes)).toEqual([
      'In ritardo',
      'Oggi',
      'Sette giorni',
      'Più avanti',
      'Senza data',
    ])
    expect(awaiting.total_amount).toBe('111.99')
    expect((await notes(s, `${byDelivery}late`)).data.map((o) => o.notes)).toEqual(['In ritardo'])
    expect((await notes(s, `${byDelivery}due_soon`)).data.map((o) => o.notes)).toEqual([
      'Oggi',
      'Sette giorni',
    ])
    const all = (await notes(s, 'sort=-delivery_date')).data.map((o) => o.notes)
    expect(all[0]).toBe('Più avanti')
    expect(all.at(-1)).toBe('Senza data')
    expect((await notes(s, `${byDelivery}late&filter[status]=received`)).data).toEqual([])

    const csv = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/purchase-orders/export?filter[follow_up]=due_soon`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\n')).toHaveLength(3)
    expect(csv.body).toContain('Sette giorni')
    expect(csv.body).toContain('Oggi')

    const wrong = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/purchase-orders?filter[follow_up]=expiring`,
    )
    expect(wrong.statusCode).toBe(422)
    expect(wrong.json<{ errors: Record<string, string[]> }>().errors).toHaveProperty(
      'filter[follow_up]',
    )
  })
})
