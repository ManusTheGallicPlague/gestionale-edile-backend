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

const ALL: Permission[] = ['sites.view', 'invoices.view', 'purchases.view']

interface Results {
  q: string
  items: { type: string; id: string; title: string; subtitle: string | null }[]
}

/** A public-works site with CIG and CUP, an invoice and an order on it, and the same on a plain site. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, values: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...values])).rows[0]?.id ?? ''
  const client = await one(
    "insert into public.clients (company_id, kind, name) values ($1, 'company', 'Comune di Prova') returning id",
  )
  const supplier = await one(
    "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
  )
  const site = await one(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const plain = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  const invoiceOn = (siteId: string, number: string) =>
    one(
      `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
         site_id, description, taxable_cents, vat_cents)
       values ($1, 'issued', $2, '2026-11-02', $3, $4, 'Primo SAL', 10000, 1000) returning id`,
      [number, client, siteId],
    )
  const orderOn = (siteId: string, seq: number) =>
    one(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         site_id, order_date) values ($1, 2026, $2, $3, $4, '2026-11-02') returning id`,
      [seq, supplier, siteId],
    )
  return {
    browser,
    company,
    site,
    invoice: await invoiceOn(site, 'FT-1'),
    order: await orderOn(site, 1),
    plainInvoice: await invoiceOn(plain, 'FT-2'),
    plainOrder: await orderOn(plain, 2),
    url: `/api/companies/${company.slug}/search`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const hits = async (s: Scene, q: string) => {
  const res = await s.browser.call('GET', `${s.url}?q=${encodeURIComponent(q)}`)
  expect(res.statusCode).toBe(200)
  return res.json<Results>().items.map((h) => [h.type, h.id])
}

describe('CIG and CUP in the quick search', () => {
  it('finds the site, its invoices and its orders by CIG or CUP', async () => {
    const s = await scene()
    const expected = [
      ['site', s.site],
      ['invoice', s.invoice],
      ['purchase_order', s.order],
    ]
    expect(await hits(s, '12345ABCDE')).toEqual(expected)
    expect(await hits(s, 'b12c34000560007')).toEqual(expected)
    // Part of the code, and the code typed with spaces.
    expect(await hits(s, '45abc')).toEqual(expected)
    expect(await hits(s, 'B12C 3400 0560 007')).toEqual(expected)
  })

  it('keeps the other searches as they were', async () => {
    const s = await scene()
    expect(await hits(s, 'FT-2')).toEqual([['invoice', s.plainInvoice]])
    expect(await hits(s, '2026/002')).toEqual([['purchase_order', s.plainOrder]])
    // Spaces still count for the other fields: «Primo SAL» is not «PrimoSAL».
    expect(await hits(s, 'PrimoSAL')).toEqual([])
  })

  it('shows only the types the user may see', async () => {
    const s = await scene(['invoices.view'])
    expect(await hits(s, '12345ABCDE')).toEqual([['invoice', s.invoice]])
  })

  it('never finds the sites, invoices or orders of another company', async () => {
    const mine = await scene()
    const other = await scene()
    const ids = (await hits(mine, '12345ABCDE')).map(([, id]) => id)
    expect(ids).toHaveLength(3)
    for (const id of [other.site, other.invoice, other.order]) expect(ids).not.toContain(id)

    const cross = await mine.browser.call('GET', `${other.url}?q=12345ABCDE`)
    expect(cross.statusCode).toBe(404)
  })
})
