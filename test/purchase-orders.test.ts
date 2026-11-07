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
  'purchases.view',
  'purchases.create',
  'purchases.update',
  'purchases.delete',
  'sites.delete',
  'suppliers.delete',
  'audit.view',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Acquisti', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1') returning id",
    [company.id],
  )
  const suppliers = await ctx.owner.query<{ id: string }>(
    `insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl'),
       ($1, 'Ferramenta Spa') returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    supplier: suppliers.rows[0]?.id ?? '',
    other: suppliers.rows[1]?.id ?? '',
    base: `/api/companies/${company.slug}/purchase-orders`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const input = (s: Scene, overrides: Record<string, unknown> = {}) => ({
  supplier_id: s.supplier,
  site_id: s.site,
  date: '2026-11-04',
  delivery_date: '2026-11-10',
  notes: null,
  lines: [
    { description: 'Calcestruzzo C25/30', unit: 'm³', quantity: '12.5', unit_price: '130' },
    { description: 'Ferro B450C', unit: 'kg', quantity: '0.333', unit_price: '0.05' },
  ],
  ...overrides,
})

type Order = {
  id: string
  number: string
  status: string
  total: string
  line_count: number
  sent_at: string | null
  received_at: string | null
}

describe('purchase orders', () => {
  it('prints the order as a PDF for the supplier', async () => {
    const s = await scene()
    await ctx.owner.query(
      `update public.suppliers set vat_number = '01234567897', street = 'Via Po 2',
         postal_code = '14100', city = 'Asti', province = 'AT' where id = $1`,
      [s.supplier],
    )
    await ctx.owner.query("update public.sites set address = 'Via Roma 1, Asti' where id = $1", [
      s.site,
    ])
    const created = await s.browser.call('POST', s.base, {
      body: input(s, { notes: 'Scarico con gru' }),
    })
    expect(created.statusCode).toBe(201)
    const order = created.json<Order>()
    const pdf = await s.browser.call('GET', `${s.base}/${order.id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    const file = `ordine-${order.number.replace('/', '-')}.pdf`
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${file}"`)
    const text = pdf.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain(`(Ordine n. ${order.number} \\(bozza, non ancora inviato\\))`)
    expect(text).toContain('(Data: 04/11/2026)')
    expect(text).toContain('(Calcestruzzi Srl)')
    expect(text).toContain('(P. IVA 01234567897)')
    expect(text).toContain('(14100 Asti \\(AT\\))')
    expect(text).toContain('(Consegna in cantiere: Villetta, Via Roma 1, Asti)')
    expect(text).toContain('(Consegna richiesta entro il 10/11/2026)')
    expect(text).toContain('(Calcestruzzo C25/30)')
    expect(text).toContain('(12,5)')
    // 12.5 × 130 = 1625.00; 0.333 × 0.05 = 0.02 (rounded): 1625.02.
    expect(text).toContain('(\x80 1.625,02)')
    expect(text).toContain('(Scarico con gru)')

    // Another company, a wrong id, no permission: 404.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', `${theirs.base}/${order.id}/pdf`)).statusCode).toBe(
      404,
    )
    expect((await s.browser.call('GET', `${s.base}/x/pdf`)).statusCode).toBe(404)
    // A member of the same company without purchases.view.
    const guest = await fx.user()
    await fx.member(
      guest.id,
      s.company.id,
      await fx.role(s.company.id, 'Ospite', ['suppliers.view']),
    )
    const browser = new Browser(ctx.app)
    await browser.signIn(guest.email)
    expect((await browser.call('GET', `${s.base}/${order.id}/pdf`)).statusCode).toBe(404)
  })

  it('exports the orders as CSV with the same filters', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, { body: input(s) })
    await s.browser.call('POST', s.base, {
      body: input(s, {
        date: '2026-11-05',
        supplier_id: s.other,
        site_id: null,
        delivery_date: null,
        lines: [],
        notes: '+39 sotto',
      }),
    })
    const url = `${s.base}/export`
    const res = await s.browser.call('GET', `${url}?sort=number`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="ordini.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toEqual([
      'Numero;Data;Fornitore;Cantiere;Consegna prevista;Stato;Righe;Totale;Note',
      '2026/001;04/11/2026;Calcestruzzi Srl;Villetta;10/11/2026;Bozza;2;1625,02;',
      "2026/002;05/11/2026;Ferramenta Spa;;;Bozza;0;0,00;'+39 sotto",
    ])
    const filtered = await s.browser.call('GET', `${url}?filter[supplier]=${s.other}`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?filter[status]=chiuso`)).statusCode).toBe(422)
    const blind = await scene(['sites.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('creates, reads, updates and deletes a draft with If-Match', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, { body: input(s) })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const order = created.json<Order>()
    expect(order).toMatchObject({
      number: '2026/001',
      status: 'draft',
      supplier: { id: s.supplier, name: 'Calcestruzzi Srl' },
      site: { id: s.site, name: 'Villetta', code: 'C-1' },
      line_count: 2,
      // 12.5 × 130.00 = 1625.00; 0.333 × 0.05 = 0.01665 → 0.02
      total: '1625.02',
      lines: [
        { quantity: '12.500', unit_price: '130.00', amount: '1625.00', unit: 'm³' },
        { quantity: '0.333', unit_price: '0.05', amount: '0.02' },
      ],
      sent_at: null,
      received_at: null,
    })
    const url = `${s.base}/${order.id}`
    expect((await s.browser.call('GET', url)).json()).toEqual(order)
    expect((await s.browser.call('PUT', url, { body: input(s) })).statusCode).toBe(428)
    const updated = await s.browser.call('PUT', url, {
      body: input(s, {
        site_id: null,
        supplier_id: s.other,
        lines: [{ description: 'Viti', unit: null, quantity: '100', unit_price: '0.1' }],
      }),
      headers: { 'If-Match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      number: '2026/001',
      site: null,
      supplier: { id: s.other },
      total: '10.00',
      line_count: 1,
    })
    const stale = await s.browser.call('PUT', url, {
      body: input(s),
      headers: { 'If-Match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)

    const log = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/audit-log?filter[entity]=purchase_order&filter[entity_id]=${order.id}`,
    )
    expect(log.statusCode).toBe(200)
    expect(log.json<{ meta: { total: number } }>().meta.total).toBe(3)
  })

  it('numbers the orders per year of the order date', async () => {
    const s = await scene()
    const numbers: string[] = []
    for (const date of ['2026-01-10', '2026-03-01', '2027-01-02']) {
      const res = await s.browser.call('POST', s.base, {
        body: input(s, { date, delivery_date: null }),
      })
      numbers.push(res.json<Order>().number)
    }
    expect(numbers).toEqual(['2026/001', '2026/002', '2027/001'])
    // Another company starts again from 1.
    const other = await scene()
    const first = await other.browser.call('POST', other.base, { body: input(other) })
    expect(first.json<Order>().number).toBe('2026/001')
  })

  it('validates the fields, the lines and the references', async () => {
    const s = await scene()
    const bad = await s.browser.call('POST', s.base, {
      body: input(s, {
        supplier_id: null,
        date: '04/11/2026',
        lines: [
          { description: ' ', unit: 'x'.repeat(21), quantity: '0', unit_price: '-1' },
          { description: 'Ok', unit: null, quantity: '1.2345', unit_price: '1.234' },
          { description: 'Troppo', unit: null, quantity: '99999999999', unit_price: '9999999' },
        ],
      }),
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'date',
      'lines.0.description',
      'lines.0.quantity',
      'lines.0.unit',
      'lines.0.unit_price',
      'lines.1.quantity',
      'lines.1.unit_price',
      'lines.2.unit_price',
      'supplier_id',
    ])
    const early = await s.browser.call('POST', s.base, {
      body: input(s, { delivery_date: '2026-11-01' }),
    })
    expect(Object.keys(early.json<{ errors: object }>().errors)).toEqual(['delivery_date'])
    const missing = await s.browser.call('POST', s.base, {
      body: { supplier_id: s.supplier, date: '2026-11-04' },
    })
    expect(missing.statusCode).toBe(422)
    expect(Object.keys(missing.json<{ errors: object }>().errors).sort()).toEqual([
      'delivery_date',
      'lines',
      'notes',
      'site_id',
    ])
    const foreign = await scene()
    const unknown = await s.browser.call('POST', s.base, {
      body: input(s, { site_id: foreign.site, supplier_id: foreign.supplier }),
    })
    expect(unknown.statusCode).toBe(422)
    expect(Object.keys(unknown.json<{ errors: object }>().errors).sort()).toEqual([
      'site_id',
      'supplier_id',
    ])
  })

  it('sends, receives and goes back; only drafts change', async () => {
    const s = await scene()
    const empty = await s.browser.call('POST', s.base, { body: input(s, { lines: [] }) })
    const emptyUrl = `${s.base}/${empty.json<Order>().id}/status`
    const noLines = await s.browser.call('POST', emptyUrl, {
      body: { status: 'sent' },
      headers: { 'If-Match': '"1"' },
    })
    expect(noLines.statusCode).toBe(422)
    expect(Object.keys(noLines.json<{ errors: object }>().errors)).toEqual(['lines'])

    const created = await s.browser.call('POST', s.base, { body: input(s) })
    const url = `${s.base}/${created.json<Order>().id}`
    const status = (value: string, version: number) =>
      s.browser.call('POST', `${url}/status`, {
        body: { status: value },
        headers: { 'If-Match': `"${version}"` },
      })
    expect(
      (await s.browser.call('POST', `${url}/status`, { body: { status: 'sent' } })).statusCode,
    ).toBe(428)
    expect((await status('received', 1)).statusCode).toBe(409)
    expect((await status('boh', 1)).statusCode).toBe(422)
    const sent = await status('sent', 1)
    expect(sent.statusCode).toBe(200)
    expect(sent.json<Order>().sent_at).not.toBeNull()
    expect((await status('sent', 1)).statusCode).toBe(412)
    const edit = await s.browser.call('PUT', url, {
      body: input(s),
      headers: { 'If-Match': '"2"' },
    })
    expect(edit.statusCode).toBe(409)
    expect(edit.json()).toMatchObject({ code: 'order_not_draft' })
    const del = await s.browser.call('DELETE', url, { headers: { 'If-Match': '"2"' } })
    expect(del.statusCode).toBe(409)
    expect(del.json()).toMatchObject({ code: 'order_not_draft' })
    const received = await status('received', 2)
    expect(received.json<Order>()).toMatchObject({ status: 'received' })
    expect(received.json<Order>().received_at).not.toBeNull()
    expect((await status('draft', 3)).json()).toMatchObject({ code: 'invalid_transition' })
    const back = await status('sent', 3)
    expect(back.json<Order>()).toMatchObject({ status: 'sent', received_at: null })
    const draft = await status('draft', 4)
    expect(draft.json<Order>()).toMatchObject({ status: 'draft', sent_at: null })

    // A site or supplier with orders cannot be deleted.
    for (const path of [`sites/${s.site}`, `suppliers/${s.supplier}`]) {
      const res = await s.browser.call('DELETE', `/api/companies/${s.company.slug}/${path}`, {
        headers: { 'If-Match': '"1"' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'has_documents' })
    }
  })

  it('lists with filters and the total of all matching orders', async () => {
    const s = await scene()
    for (const body of [
      input(s),
      input(s, { date: '2026-11-01', delivery_date: null, site_id: null }),
      input(s, {
        supplier_id: s.other,
        date: '2026-11-02',
        lines: [{ description: 'Viti', unit: null, quantity: '1', unit_price: '0.25' }],
      }),
    ]) {
      expect((await s.browser.call('POST', s.base, { body })).statusCode).toBe(201)
    }
    type List = { data: Order[]; meta: { total: number }; total_amount: string }
    const all = (await s.browser.call('GET', `${s.base}?per_page=1`)).json<List>()
    expect(all.data.map((o) => o.number)).toEqual(['2026/001'])
    expect(all.data[0]).not.toHaveProperty('lines')
    expect(all.meta.total).toBe(3)
    expect(all.total_amount).toBe('3250.29')
    const bySupplier = await s.browser.call('GET', `${s.base}?filter[supplier]=${s.other}`)
    expect(bySupplier.json<List>().total_amount).toBe('0.25')
    const bySite = await s.browser.call(
      'GET',
      `${s.base}?filter[site]=${s.site}&filter[from]=2026-11-02&filter[to]=2026-11-30&sort=total`,
    )
    expect(bySite.json<List>().data.map((o) => o.total)).toEqual(['0.25', '1625.02'])
    const drafts = await s.browser.call('GET', `${s.base}?filter[status]=draft&sort=-number`)
    expect(drafts.json<List>().data.map((o) => o.number)).toEqual([
      '2026/003',
      '2026/002',
      '2026/001',
    ])
    expect((await s.browser.call('GET', `${s.base}?filter[status]=x`)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${s.base}?sort=boh`)).statusCode).toBe(422)
  })

  it('needs the purchases permissions', async () => {
    const owner = await scene()
    const created = await owner.browser.call('POST', owner.base, { body: input(owner) })
    const url = `${owner.base}/${created.json<Order>().id}`
    const reader = await fx.user()
    const role = await fx.role(owner.company.id, 'Lettura', ['purchases.view'])
    await fx.member(reader.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.email)
    expect((await browser.call('GET', url)).statusCode).toBe(200)
    expect((await browser.call('POST', owner.base, { body: input(owner) })).statusCode).toBe(403)
    const headers = { 'If-Match': '"1"' }
    expect((await browser.call('PUT', url, { body: input(owner), headers })).statusCode).toBe(403)
    expect(
      (await browser.call('POST', `${url}/status`, { body: { status: 'sent' }, headers }))
        .statusCode,
    ).toBe(403)
    expect((await browser.call('DELETE', url, { headers })).statusCode).toBe(403)
    const none = await scene(['clients.view'])
    expect((await none.browser.call('GET', none.base)).statusCode).toBe(403)
    expect(
      (await none.browser.call('GET', `${none.base}/${created.json<Order>().id}`)).statusCode,
    ).toBe(404)
    // Another company's order is not found, not even with all the permissions.
    const stranger = await scene()
    expect(
      (await stranger.browser.call('GET', `${stranger.base}/${created.json<Order>().id}`))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await stranger.browser.call('PUT', `${stranger.base}/${created.json<Order>().id}`, {
          body: input(stranger),
          headers,
        })
      ).statusCode,
    ).toBe(404)
  })
})
