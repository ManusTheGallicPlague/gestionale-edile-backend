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

const ALL: Permission[] = ['invoices.view', 'invoices.create', 'purchases.view', 'purchases.create']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  return {
    browser,
    company,
    client: await one(
      "insert into public.clients (company_id, kind, name) values ($1, 'company', 'Comune di Prova') returning id",
    ),
    supplier: await one(
      "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
    ),
    site: await one(
      `insert into public.sites (company_id, name, code, cig, cup)
         values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
    ),
    plain: await one(
      "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
    ),
    invoices: `/api/companies/${company.slug}/invoices`,
    orders: `/api/companies/${company.slug}/purchase-orders`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>
type Site = { id: string; cig: string | null; cup: string | null } | null

const invoice = (s: Scene, site: string | null) => ({
  direction: 'issued',
  number: '1/2026',
  date: '2026-11-02',
  client_id: s.client,
  supplier_id: null,
  site_id: site,
  description: 'Primo SAL',
  taxable_amount: '10000',
  vat_amount: '1000',
  due_date: null,
  paid_on: null,
  notes: null,
})

const order = (s: Scene, site: string | null) => ({
  supplier_id: s.supplier,
  site_id: site,
  date: '2026-11-04',
  delivery_date: null,
  notes: null,
  lines: [{ description: 'Calcestruzzo C25/30', unit: 'm³', quantity: '10', unit_price: '130' }],
})

describe('CIG and CUP of the site in invoices', () => {
  it('come with the site of the invoice, in the detail and in the list', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.invoices, { body: invoice(s, s.site) })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    expect(created.json<{ site: Site }>().site).toMatchObject({
      id: s.site,
      cig: '12345ABCDE',
      cup: 'B12C34000560007',
    })

    // They follow the site: the office fixes the CUP once, every invoice shows it.
    await ctx.owner.query('update public.sites set cup = null where id = $1', [s.site])
    const read = await s.browser.call('GET', `${s.invoices}/${id}`)
    expect(read.statusCode).toBe(200)
    expect(read.json<{ site: Site }>().site).toMatchObject({ cig: '12345ABCDE', cup: null })

    const other = await s.browser.call('POST', s.invoices, {
      body: { ...invoice(s, s.plain), number: '2/2026' },
    })
    expect(other.json<{ site: Site }>().site).toMatchObject({ cig: null, cup: null })
    const none = await s.browser.call('POST', s.invoices, {
      body: { ...invoice(s, null), number: '3/2026' },
    })
    expect(none.json<{ site: Site }>().site).toBeNull()

    const list = await s.browser.call('GET', `${s.invoices}?filter[site]=${s.site}`)
    expect(list.statusCode).toBe(200)
    const items = list.json<{ data: { site: Site }[] }>().data
    expect(items.map((i) => i.site?.cig)).toEqual(['12345ABCDE'])
  })

  it('do not show to a member of another company', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.invoices, { body: invoice(s, s.site) })
    const id = created.json<{ id: string }>().id
    const stranger = await scene()
    const read = await stranger.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/invoices/${id}`,
    )
    expect(read.statusCode).toBe(404)
    const own = await stranger.browser.call('GET', `${stranger.invoices}/${id}`)
    expect(own.statusCode).toBe(404)
  })
})

describe('CIG and CUP of the site in purchase orders', () => {
  it('come with the site of the order and are printed on the PDF for the supplier', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.orders, { body: order(s, s.site) })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    expect(created.json<{ site: Site }>().site).toMatchObject({
      cig: '12345ABCDE',
      cup: 'B12C34000560007',
    })
    const list = await s.browser.call('GET', s.orders)
    expect(list.json<{ data: { site: Site }[] }>().data[0]?.site).toMatchObject({
      cig: '12345ABCDE',
      cup: 'B12C34000560007',
    })

    const pdf = await s.browser.call('GET', `${s.orders}/${id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.rawPayload.toString('latin1')).toContain(
      '(CIG 12345ABCDE - CUP B12C34000560007, da riportare in fattura)',
    )

    await ctx.owner.query('update public.sites set cup = null where id = $1', [s.site])
    const onlyCig = await s.browser.call('GET', `${s.orders}/${id}/pdf`)
    const text = onlyCig.rawPayload.toString('latin1')
    expect(text).toContain('(CIG 12345ABCDE, da riportare in fattura)')
    expect(text).not.toContain('CUP')
  })

  it('leave the PDF unchanged on a site without them', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.orders, { body: order(s, s.plain) })
    const id = created.json<{ id: string; site: Site }>().id
    expect(created.json<{ site: Site }>().site).toMatchObject({ cig: null, cup: null })
    const pdf = await s.browser.call('GET', `${s.orders}/${id}/pdf`)
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('(Consegna in cantiere: Villetta)')
    expect(text).not.toContain('da riportare in fattura')
  })
})
