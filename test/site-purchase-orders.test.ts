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

const ALL: Permission[] = ['costs.view', 'purchases.view', 'invoices.view']

/** A company with two sites and a supplier; orders and invoices are written as the owner. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, params: unknown[]) =>
    (await ctx.owner.query<{ id: string }>(sql, params)).rows[0]?.id ?? ''
  const site = (name: string) =>
    one('insert into public.sites (company_id, name) values ($1, $2) returning id', [
      company.id,
      name,
    ])
  const supplier = await one(
    "insert into public.suppliers (company_id, name) values ($1, 'Edilmateriali') returning id",
    [company.id],
  )
  let seq = 0
  /** An order with lines as [quantity, unit price in cents]. */
  const order = async (status: string, siteId: string | null, lines: [string, number][]) => {
    seq += 1
    const id = await one(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         site_id, order_date, status, sent_at, received_at)
       values ($1, 2026, $2, $3, $4, '2026-10-20', $5,
         case when $5 <> 'draft' then now() end, case when $5 = 'received' then now() end)
       returning id`,
      [company.id, seq, supplier, siteId, status],
    )
    for (const [position, [quantity, cents]] of lines.entries()) {
      await ctx.owner.query(
        `insert into public.purchase_order_lines (company_id, order_id, position, description,
           quantity, unit_price_cents) values ($1, $2, $3, 'Materiale', $4, $5)`,
        [company.id, id, position, quantity, cents],
      )
    }
    return id
  }
  /** A received invoice of the supplier, linked to an order or to a site. */
  const invoice = (cents: number, orderId: string | null, siteId: string | null = null) =>
    ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         site_id, taxable_cents, vat_cents, purchase_order_id)
       values ($1, 'received', $2, '2026-11-02', $3, $4, $5, 0, $6)`,
      [company.id, `F${Math.floor(Math.random() * 1_000_000)}`, supplier, siteId, cents, orderId],
    )
  const base = `/api/companies/${company.slug}`
  return {
    browser,
    company,
    base,
    order,
    invoice,
    site: await site('Villetta'),
    other: await site('Capannone'),
  }
}

type Summary = {
  total: string
  purchase_orders: {
    count: number
    received: number
    total: string
    received_total: string
    invoiced: string | null
  } | null
}

describe('purchase orders in the site cost summary', () => {
  it('sums sent and received orders of the site, and the invoices linked to them', async () => {
    const s = await scene()
    // 1.5 × 0.10 = 0.15 and 3 × 33.33 = 99.99: rounded line by line, as the order total.
    const sent = await s.order('sent', s.site, [
      ['1.5', 10],
      ['3', 3333],
    ])
    const received = await s.order('received', s.site, [['0.333', 100]])
    await s.order('draft', s.site, [['10', 10000]])
    await s.order('sent', s.other, [['1', 5000]])
    await s.order('sent', null, [['1', 7000]])
    await s.order('sent', s.site, [])
    await s.invoice(10, received)
    await s.invoice(20, received)
    await s.invoice(5000, sent)
    await s.invoice(9900, null, s.site)
    const res = await s.browser.call('GET', `${s.base}/sites/${s.site}/cost-summary`)
    expect(res.statusCode).toBe(200)
    expect(res.json<Summary>()).toMatchObject({
      total: '0.00',
      purchase_orders: {
        count: 3,
        received: 1,
        total: '100.47',
        received_total: '0.33',
        invoiced: '50.30',
      },
    })
    const other = await s.browser.call('GET', `${s.base}/sites/${s.other}/cost-summary`)
    expect(other.json<Summary>().purchase_orders).toEqual({
      count: 1,
      received: 0,
      total: '50.00',
      received_total: '0.00',
      invoiced: '0.00',
    })
  })

  it('matches the orders listed for the site', async () => {
    const s = await scene()
    const sent = await s.order('sent', s.site, [['2.5', 1999]])
    await s.order('received', s.site, [['7', 1234]])
    await s.order('draft', s.site, [['1', 100]])
    await s.invoice(4000, sent)
    const list = await s.browser.call(
      'GET',
      `${s.base}/purchase-orders?filter[site]=${s.site}&page[size]=100`,
    )
    expect(list.statusCode).toBe(200)
    const orders = list
      .json<{ data: { status: string; total: string; invoiced_amount: string }[] }>()
      .data.filter((o) => o.status !== 'draft')
    const cents = (a: string) => BigInt(a.replace('.', ''))
    const sum = (key: 'total' | 'invoiced_amount') =>
      orders.reduce((total, o) => total + cents(o[key]), 0n)
    const res = await s.browser.call('GET', `${s.base}/sites/${s.site}/cost-summary`)
    const summary = res.json<Summary>().purchase_orders
    expect(summary?.count).toBe(orders.length)
    expect(cents(summary?.total ?? '')).toBe(sum('total'))
    expect(cents(summary?.invoiced ?? '')).toBe(sum('invoiced_amount'))
  })

  it('is zero for a site without orders', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.base}/sites/${s.site}/cost-summary`)
    expect(res.json<Summary>().purchase_orders).toEqual({
      count: 0,
      received: 0,
      total: '0.00',
      received_total: '0.00',
      invoiced: '0.00',
    })
  })

  it('is null without purchases.view, invoiced is null without invoices.view', async () => {
    const blind = await scene(['costs.view', 'invoices.view'])
    await blind.order('sent', blind.site, [['1', 100]])
    const none = await blind.browser.call('GET', `${blind.base}/sites/${blind.site}/cost-summary`)
    expect(none.statusCode).toBe(200)
    expect(none.json<Summary>().purchase_orders).toBeNull()
    const partial = await scene(['costs.view', 'purchases.view'])
    const sent = await partial.order('sent', partial.site, [['1', 100]])
    await partial.invoice(100, sent)
    const res = await partial.browser.call(
      'GET',
      `${partial.base}/sites/${partial.site}/cost-summary`,
    )
    expect(res.json<Summary>().purchase_orders).toMatchObject({ total: '1.00', invoiced: null })
  })

  it('does not count or show the orders of another company', async () => {
    const s = await scene()
    await s.order('sent', s.site, [['1', 1000]])
    const intruder = await scene()
    await intruder.order('sent', intruder.site, [['1', 99900]])
    const res = await s.browser.call('GET', `${s.base}/sites/${s.site}/cost-summary`)
    expect(res.json<Summary>().purchase_orders).toMatchObject({ count: 1, total: '10.00' })
    const peek = await intruder.browser.call('GET', `${intruder.base}/sites/${s.site}/cost-summary`)
    expect(peek.statusCode).toBe(404)
    const own = await intruder.browser.call(
      'GET',
      `${intruder.base}/sites/${intruder.site}/cost-summary`,
    )
    expect(own.json<Summary>().purchase_orders).toMatchObject({ count: 1, total: '999.00' })
  })
})
