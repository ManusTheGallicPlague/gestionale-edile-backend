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

async function scene() {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const s = {
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
  for (const [number, site] of [
    ['1/2026', s.site],
    ['2/2026', s.plain],
  ] as const) {
    const created = await browser.call('POST', s.invoices, {
      body: {
        direction: 'issued',
        number,
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
      },
    })
    expect(created.statusCode).toBe(201)
    const order = await browser.call('POST', s.orders, {
      body: {
        supplier_id: s.supplier,
        site_id: site,
        date: '2026-11-04',
        delivery_date: null,
        notes: `Ordine ${number}`,
        lines: [{ description: 'Calcestruzzo', unit: 'm³', quantity: '10', unit_price: '130' }],
      },
    })
    expect(order.statusCode).toBe(201)
  }
  return s
}

type Scene = Awaited<ReturnType<typeof scene>>

const numbers = async (s: Scene, path: string) => {
  const res = await s.browser.call('GET', path)
  expect(res.statusCode).toBe(200)
  return res
    .json<{ data: { number: string; site: { name: string } | null }[] }>()
    .data.map((d) => d.site?.name)
}

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the lists of invoices and orders', () => {
  it('find invoices and orders from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      const query = `?filter[q]=${encodeURIComponent(q)}`
      expect(await numbers(s, `${s.invoices}${query}`)).toEqual(['Scuola'])
      expect(await numbers(s, `${s.orders}${query}`)).toEqual(['Scuola'])
    }
    // The other fields are searched as before.
    expect(await numbers(s, `${s.invoices}?filter[q]=2%2F2026`)).toEqual(['Villetta'])
    expect(await numbers(s, `${s.orders}?filter[q]=Ordine%202`)).toEqual(['Villetta'])

    // Totals follow the filter.
    const list = await s.browser.call('GET', `${s.invoices}?filter[q]=12345abcde`)
    expect(list.json<{ meta: { total: number }; total_amount: string }>()).toMatchObject({
      meta: { total: 1 },
      total_amount: '11000.00',
    })
    const orders = await s.browser.call('GET', `${s.orders}?filter[q]=12345abcde`)
    expect(orders.json<{ meta: { total: number } }>().meta.total).toBe(1)
  })

  it('end the CSV files with the CIG and CUP columns', async () => {
    const s = await scene()
    const invoices = await s.browser.call('GET', `${s.invoices}/export?sort=date`)
    expect(invoices.statusCode).toBe(200)
    const [head, ...rows] = lines(invoices.body)
    expect(head).toMatch(/;Fattura stornata;CIG;CUP$/)
    expect(rows.find((r) => r.includes('Scuola'))).toMatch(/;12345ABCDE;B12C34000560007$/)
    expect(rows.find((r) => r.includes('Villetta'))).toMatch(/;;$/)

    const orders = await s.browser.call('GET', `${s.orders}/export?filter[q]=B12C34000560007`)
    expect(orders.statusCode).toBe(200)
    const [orderHead, ...orderRows] = lines(orders.body)
    expect(orderHead).toMatch(/;Fatturato;CIG;CUP$/)
    expect(orderRows).toHaveLength(1)
    expect(orderRows[0]).toMatch(/;12345ABCDE;B12C34000560007$/)
  })

  it('do not find the documents of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(`update public.sites set cig = 'ZZZZZ99999' where id = $1`, [s.site])
    for (const base of [stranger.invoices, stranger.orders]) {
      expect(await numbers(stranger, `${base}?filter[q]=ZZZZZ99999`)).toEqual([])
    }
    for (const base of [
      `/api/companies/${s.company.slug}/invoices`,
      `/api/companies/${s.company.slug}/purchase-orders`,
    ]) {
      const res = await stranger.browser.call('GET', `${base}?filter[q]=ZZZZZ99999`)
      expect(res.statusCode).toBe(404)
    }
  })
})
