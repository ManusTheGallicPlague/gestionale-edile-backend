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
    const csv = await s.browser.call('GET', `${s.base}/export`)
    expect(csv.body).toContain(';1220,00;200,00;1020,00;03/11/2026;;Scaduta;')
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

  it('lists the payments of the whole company with filters and totals', async () => {
    const s = await scene()
    const supplier =
      (
        await ctx.owner.query<{ id: string }>(
          "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
          [s.company.id],
        )
      ).rows[0]?.id ?? ''
    const site =
      (
        await ctx.owner.query<{ id: string }>(
          "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1') returning id",
          [s.company.id],
        )
      ).rows[0]?.id ?? ''
    const out = await invoice(s, { site_id: site })
    const into = await invoice(s, { direction: 'received', client_id: null, supplier_id: supplier })
    await s.browser.call('POST', `${s.base}/${out.id}/payments`, {
      body: payment({ date: '2026-11-05', amount: '300' }),
      headers: { 'If-Match': '"1"' },
    })
    await s.browser.call('POST', `${s.base}/${out.id}/payments`, {
      body: payment({ date: '2026-11-15', amount: '100', method: 'cash' }),
      headers: { 'If-Match': '"2"' },
    })
    await s.browser.call('POST', `${s.base}/${into.id}/payments`, {
      body: payment({ date: '2026-11-10', amount: '50', method: 'riba' }),
      headers: { 'If-Match': '"1"' },
    })
    // A payment of another company never shows up.
    const other = await scene()
    const foreign = await invoice(other)
    await other.browser.call('POST', `${other.base}/${foreign.id}/payments`, {
      body: payment(),
      headers: { 'If-Match': '"1"' },
    })

    const url = `/api/companies/${s.company.slug}/invoice-payments`
    const all = await s.browser.call('GET', url)
    expect(all.statusCode).toBe(200)
    const body = all.json<{
      data: { date: string; invoice: { direction: string; subject: { name: string } } }[]
      meta: { total: number }
      collected: string
      paid: string
    }>()
    expect(body.data.map((p) => p.date)).toEqual(['2026-11-15', '2026-11-10', '2026-11-05'])
    expect(body.data[1]?.invoice).toMatchObject({
      direction: 'received',
      subject: { name: 'Calcestruzzi Srl' },
      site: null,
    })
    expect(body).toMatchObject({ meta: { total: 3 }, collected: '400.00', paid: '50.00' })

    const filtered = await s.browser.call(
      'GET',
      `${url}?filter[direction]=issued&filter[from]=2026-11-01&filter[to]=2026-11-10&filter[site]=${site}`,
    )
    expect(filtered.json()).toMatchObject({ meta: { total: 1 }, collected: '300.00', paid: '0.00' })
    const cash = await s.browser.call('GET', `${url}?filter[method]=cash&per_page=1`)
    expect(cash.json()).toMatchObject({ meta: { total: 1, per_page: 1 }, collected: '100.00' })
    expect((await s.browser.call('GET', `${url}?filter[method]=gold`)).statusCode).toBe(422)
    expect((await s.browser.call('GET', `${url}?filter[from]=ieri`)).statusCode).toBe(422)

    const csv = await s.browser.call('GET', `${url}/export?filter[direction]=received`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="incassi-e-pagamenti.csv"',
    )
    const lines = csv.body.replace('\ufeff', '').trim().split('\r\n')
    expect(lines[0]).toBe('Data;Tipo;Fattura;Cliente o fornitore;Cantiere;Importo;Modalità;Note')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^10\/11\/2026;Pagamento;F-\w+;Calcestruzzi Srl;;50,00;RiBa;$/)
    expect((await s.browser.call('GET', `${url}/export?filter[to]=x`)).statusCode).toBe(422)

    const blind = await scene(['deadlines.view'])
    const blindUrl = `/api/companies/${blind.company.slug}/invoice-payments`
    expect((await blind.browser.call('GET', blindUrl)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', `${blindUrl}/export`)).statusCode).toBe(403)
  })

  it('filters the payments by client and by supplier, in the list and in the CSV', async () => {
    const s = await scene()
    const supplier =
      (
        await ctx.owner.query<{ id: string }>(
          "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
          [s.company.id],
        )
      ).rows[0]?.id ?? ''
    const anna =
      (
        await ctx.owner.query<{ id: string }>(
          "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Anna Verdi') returning id",
          [s.company.id],
        )
      ).rows[0]?.id ?? ''
    const mario = await invoice(s)
    const verdi = await invoice(s, { client_id: anna })
    const into = await invoice(s, { direction: 'received', client_id: null, supplier_id: supplier })
    for (const [id, amount, date] of [
      [mario.id, '0.10', '2026-11-05'],
      [mario.id, '0.20', '2026-11-06'],
      [verdi.id, '7', '2026-11-07'],
      [into.id, '50', '2026-11-08'],
    ] as const) {
      const version = id === mario.id && amount === '0.20' ? '"2"' : '"1"'
      const res = await s.browser.call('POST', `${s.base}/${id}/payments`, {
        body: payment({ date, amount }),
        headers: { 'If-Match': version },
      })
      expect(res.statusCode).toBe(200)
    }
    const url = `/api/companies/${s.company.slug}/invoice-payments`
    type Payments = {
      data: { date: string }[]
      meta: { total: number }
      collected: string
      paid: string
    }
    const get = async (query: string) => {
      const res = await s.browser.call('GET', `${url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<Payments>()
    }
    const ofMario = await get(`filter[client]=${s.client}`)
    expect(ofMario.data.map((p) => p.date)).toEqual(['2026-11-06', '2026-11-05'])
    expect(ofMario).toMatchObject({ meta: { total: 2 }, collected: '0.30', paid: '0.00' })
    const toSupplier = await get(`filter[supplier]=${supplier}`)
    expect(toSupplier).toMatchObject({ meta: { total: 1 }, collected: '0.00', paid: '50.00' })
    // A client only has issued invoices: with the supplier filter too nothing is left.
    expect((await get(`filter[client]=${anna}&filter[supplier]=${supplier}`)).meta.total).toBe(0)
    const csv = await s.browser.call('GET', `${url}/export?filter[client]=${anna}`)
    expect(csv.statusCode).toBe(200)
    const lines = csv.body.replace('\ufeff', '').trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/;Anna Verdi;;7,00;/)
    // A client or supplier of another company gives an empty list.
    const other = await scene()
    const foreign = await invoice(other)
    await other.browser.call('POST', `${other.base}/${foreign.id}/payments`, {
      body: payment(),
      headers: { 'If-Match': '"1"' },
    })
    expect(await get(`filter[client]=${other.client}`)).toMatchObject({
      data: [],
      meta: { total: 0 },
      collected: '0.00',
    })
    for (const query of [
      'filter[client]=abc',
      'filter[supplier]=abc',
      `filter[client]=${s.client}&filter[client]=${anna}`,
    ]) {
      expect((await s.browser.call('GET', `${url}?${query}`)).statusCode).toBe(422)
      expect((await s.browser.call('GET', `${url}/export?${query}`)).statusCode).toBe(422)
    }
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
