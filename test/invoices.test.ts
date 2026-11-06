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
  'invoices.view',
  'invoices.create',
  'invoices.update',
  'invoices.delete',
  'deadlines.view',
  'clients.delete',
  'suppliers.delete',
  'sites.delete',
  'audit.view',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Amministrazione', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  return {
    browser,
    company,
    client: await one(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
    ),
    supplier: await one(
      "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
    ),
    other: await one(
      "insert into public.suppliers (company_id, name) values ($1, 'Ferramenta Spa') returning id",
    ),
    site: await one(
      "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1') returning id",
    ),
    base: `/api/companies/${company.slug}/invoices`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const issued = (s: Scene, overrides: Record<string, unknown> = {}) => ({
  direction: 'issued',
  number: '12/2026',
  date: '2026-11-02',
  client_id: s.client,
  supplier_id: null,
  site_id: s.site,
  description: 'Primo SAL',
  taxable_amount: '10000',
  vat_amount: '1000.50',
  due_date: '2026-12-31',
  paid_on: null,
  notes: null,
  ...overrides,
})

const received = (s: Scene, overrides: Record<string, unknown> = {}) =>
  issued(s, {
    direction: 'received',
    number: 'A-77',
    client_id: null,
    supplier_id: s.supplier,
    description: 'Calcestruzzo',
    taxable_amount: '1500',
    vat_amount: '330',
    ...overrides,
  })

type Invoice = {
  id: string
  number: string
  total: string
  payment_status: string
  deadline_id: string | null
}
type Deadline = { id: string; status: string; done_at: string | null; due_on: string }

describe('invoices', () => {
  it('creates, reads, updates and deletes with If-Match, keeping its deadline in step', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, { body: issued(s) })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const invoice = created.json<Invoice>()
    expect(invoice).toMatchObject({
      direction: 'issued',
      number: '12/2026',
      client: { id: s.client, name: 'Mario Bianchi' },
      supplier: null,
      site: { id: s.site, name: 'Villetta', code: 'C-1' },
      taxable_amount: '10000.00',
      vat_amount: '1000.50',
      total: '11000.50',
      payment_status: 'open',
    })
    expect(invoice.deadline_id).not.toBeNull()
    const url = `${s.base}/${invoice.id}`
    expect((await s.browser.call('GET', url)).json()).toEqual(invoice)

    const deadlineUrl = `/api/companies/${s.company.slug}/deadlines/${invoice.deadline_id}`
    const deadline = await s.browser.call('GET', deadlineUrl)
    expect(deadline.json()).toMatchObject({
      title: 'Fattura 12/2026 – Mario Bianchi',
      kind: 'invoice_out',
      due_on: '2026-12-31',
      amount: '11000.50',
      client_id: s.client,
      invoice_id: invoice.id,
      status: 'open',
    })

    expect((await s.browser.call('PUT', url, { body: issued(s) })).statusCode).toBe(428)
    const paid = await s.browser.call('PUT', url, {
      body: issued(s, { paid_on: '2026-11-20', due_date: '2026-12-15' }),
      headers: { 'If-Match': '"1"' },
    })
    expect(paid.statusCode).toBe(200)
    expect(paid.json()).toMatchObject({ payment_status: 'paid', paid_on: '2026-11-20' })
    const done = (await s.browser.call('GET', deadlineUrl)).json<Deadline>()
    expect(done).toMatchObject({ status: 'done', due_on: '2026-12-15' })
    expect(done.done_at).not.toBeNull()

    const reopened = await s.browser.call('PUT', url, {
      body: issued(s),
      headers: { 'If-Match': '"2"' },
    })
    expect(reopened.json()).toMatchObject({ payment_status: 'open', paid_on: null })
    expect((await s.browser.call('GET', deadlineUrl)).json()).toMatchObject({
      status: 'open',
      done_at: null,
    })

    const stale = await s.browser.call('PUT', url, {
      body: issued(s),
      headers: { 'If-Match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)

    const noDue = await s.browser.call('PUT', url, {
      body: issued(s, { due_date: null }),
      headers: { 'If-Match': '"3"' },
    })
    expect(noDue.json()).toMatchObject({ deadline_id: null, payment_status: 'open' })
    expect((await s.browser.call('GET', deadlineUrl)).statusCode).toBe(404)

    const withDue = await s.browser.call('PUT', url, {
      body: issued(s),
      headers: { 'If-Match': '"4"' },
    })
    const newDeadline = withDue.json<Invoice>().deadline_id
    expect(newDeadline).not.toBeNull()
    expect(
      (await s.browser.call('DELETE', url, { headers: { 'If-Match': '"5"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)
    const left = await ctx.owner.query('select 1 from public.deadlines where id = $1', [
      newDeadline,
    ])
    expect(left.rowCount).toBe(0)

    const log = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/audit-log?filter[entity]=invoice&filter[entity_id]=${invoice.id}`,
    )
    expect(log.statusCode).toBe(200)
    expect(log.json<{ meta: { total: number } }>().meta.total).toBe(6)
  })

  it('a received invoice belongs to a supplier and opens an invoice_in deadline', async () => {
    const s = await scene()
    const res = await s.browser.call('POST', s.base, { body: received(s, { site_id: null }) })
    expect(res.statusCode).toBe(201)
    const invoice = res.json<Invoice>()
    expect(invoice).toMatchObject({
      supplier: { id: s.supplier, name: 'Calcestruzzi Srl' },
      client: null,
      site: null,
      total: '1830.00',
    })
    const deadline = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/deadlines/${invoice.deadline_id}`,
    )
    expect(deadline.json()).toMatchObject({
      kind: 'invoice_in',
      supplier_id: s.supplier,
      amount: '1830.00',
    })
  })

  it('a number is used once per year (per supplier for received invoices)', async () => {
    const s = await scene()
    expect((await s.browser.call('POST', s.base, { body: issued(s) })).statusCode).toBe(201)
    const again = await s.browser.call('POST', s.base, {
      body: issued(s, { number: ' 12/2026 ' }),
    })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({
      errors: { number: ['Questo numero è già stato registrato per lo stesso anno.'] },
    })
    const nextYear = await s.browser.call('POST', s.base, {
      body: issued(s, { date: '2027-01-05', due_date: null }),
    })
    expect(nextYear.statusCode).toBe(201)
    expect((await s.browser.call('POST', s.base, { body: received(s) })).statusCode).toBe(201)
    const sameSupplier = await s.browser.call('POST', s.base, {
      body: received(s, { number: 'a-77' }),
    })
    expect(sameSupplier.statusCode).toBe(422)
    const otherSupplier = await s.browser.call('POST', s.base, {
      body: received(s, { supplier_id: s.other }),
    })
    expect(otherSupplier.statusCode).toBe(201)
    // A received invoice does not clash with our own numbering.
    const sameAsIssued = await s.browser.call('POST', s.base, {
      body: received(s, { number: '12/2026' }),
    })
    expect(sameAsIssued.statusCode).toBe(201)
    // Another company has its own numbering.
    const t = await scene()
    expect((await t.browser.call('POST', t.base, { body: issued(t) })).statusCode).toBe(201)
  })

  it.each([
    ['no direction', { direction: 'sent' }, 'direction'],
    ['no number', { number: '  ' }, 'number'],
    ['a bad date', { date: '2026-02-30' }, 'date'],
    ['no client', { client_id: null }, 'client_id'],
    [
      'a supplier on an issued invoice',
      { supplier_id: '00000000-0000-4000-8000-000000000000' },
      'supplier_id',
    ],
    ['a float amount', { taxable_amount: 10.5 }, 'taxable_amount'],
    ['a negative VAT', { vat_amount: '-1' }, 'vat_amount'],
    ['too many decimals', { vat_amount: '1.001' }, 'vat_amount'],
    ['a huge amount', { taxable_amount: '100000000000' }, 'taxable_amount'],
    ['a due date before the invoice', { due_date: '2026-11-01' }, 'due_date'],
    ['a bad payment date', { paid_on: 'ieri' }, 'paid_on'],
    ['a missing field', { notes: undefined }, 'notes'],
  ])('rejects %s', async (_, overrides, field) => {
    const s = await scene()
    const body: Record<string, unknown> = issued(s, overrides)
    if ('notes' in overrides && overrides.notes === undefined) delete body.notes
    const res = await s.browser.call('POST', s.base, { body })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('clients, suppliers and sites of another company cannot be named', async () => {
    const mine = await scene()
    const theirs = await scene()
    const client = await mine.browser.call('POST', mine.base, {
      body: issued(mine, { client_id: theirs.client, site_id: theirs.site }),
    })
    expect(client.statusCode).toBe(422)
    expect(client.json()).toMatchObject({
      errors: { client_id: ['Cliente non trovato.'], site_id: ['Cantiere non trovato.'] },
    })
    const supplier = await mine.browser.call('POST', mine.base, {
      body: received(mine, { supplier_id: theirs.supplier }),
    })
    expect(supplier.json()).toMatchObject({ errors: { supplier_id: ['Fornitore non trovato.'] } })
    // And another company's invoice is not found.
    const created = await theirs.browser.call('POST', theirs.base, { body: issued(theirs) })
    const id = created.json<Invoice>().id
    expect((await mine.browser.call('GET', `${mine.base}/${id}`)).statusCode).toBe(404)
    const put = await mine.browser.call('PUT', `${mine.base}/${id}`, {
      body: issued(mine),
      headers: { 'If-Match': '"1"' },
    })
    expect(put.statusCode).toBe(404)
    const del = await mine.browser.call('DELETE', `${mine.base}/${id}`, {
      headers: { 'If-Match': '"1"' },
    })
    expect(del.statusCode).toBe(404)
  })

  it('lists with filters, sorting and totals of the whole selection', async () => {
    const s = await scene()
    const today = new Date().toISOString().slice(0, 10)
    await s.browser.call('POST', s.base, {
      body: issued(s, { number: '1', date: '2020-01-10', due_date: '2020-02-10' }),
    })
    await s.browser.call('POST', s.base, {
      body: issued(s, { number: '2', date: '2020-03-10', due_date: null, paid_on: '2020-03-20' }),
    })
    await s.browser.call('POST', s.base, {
      body: received(s, { date: today, due_date: null, site_id: null, description: 'Ferro' }),
    })
    const all = await s.browser.call('GET', s.base)
    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({
      meta: { total: 3, page: 1, per_page: 25 },
      total_amount: '23831.00',
      outstanding_amount: '12830.50',
    })
    const list = async (query: string) =>
      (await s.browser.call('GET', `${s.base}?${query}`)).json<{
        data: Invoice[]
        meta: { total: number }
        outstanding_amount: string
      }>()
    expect((await list('filter[direction]=issued')).data.map((i) => i.number)).toEqual(['2', '1'])
    expect((await list('filter[status]=overdue')).data.map((i) => i.number)).toEqual(['1'])
    expect((await list('filter[status]=paid')).data.map((i) => i.number)).toEqual(['2'])
    expect((await list('filter[status]=open')).data.map((i) => i.number)).toEqual(['A-77'])
    expect((await list(`filter[supplier]=${s.supplier}`)).meta.total).toBe(1)
    expect((await list(`filter[client]=${s.client}`)).meta.total).toBe(2)
    expect((await list(`filter[site]=${s.site}`)).meta.total).toBe(2)
    expect((await list('filter[from]=2020-02-01&filter[to]=2020-12-31')).meta.total).toBe(1)
    expect((await list('filter[q]=ferr')).data.map((i) => i.number)).toEqual(['A-77'])
    expect((await list('filter[q]=100%25')).meta.total).toBe(0)
    expect((await list('sort=total')).data[0]?.number).toBe('A-77')
    expect((await list('sort=-total')).data[2]?.number).toBe('A-77')
    expect((await list('sort=due_date')).data[0]?.number).toBe('1')
    const paged = await list('per_page=1&page=2&sort=date')
    expect(paged.data.map((i) => i.number)).toEqual(['2'])
    expect(paged.outstanding_amount).toBe('12830.50')
    for (const bad of [
      'filter[direction]=out',
      'filter[status]=late',
      'sort=number',
      'per_page=101',
    ]) {
      expect((await s.browser.call('GET', `${s.base}?${bad}`)).statusCode).toBe(422)
    }
  })

  it('exports the register as CSV with the same filters', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, {
      body: issued(s, { notes: '=SOMMA(A1)', paid_on: '2026-11-20' }),
    })
    await s.browser.call('POST', s.base, {
      body: received(s, { date: '2026-11-03', due_date: null, site_id: null }),
    })
    const url = `${s.base}/export`
    const res = await s.browser.call('GET', `${url}?sort=date`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="fatture.csv"')
    const lines = res.body.replace('﻿', '').trim().split('\r\n')
    expect(lines).toEqual([
      'Tipo;Numero;Data;Cliente o fornitore;Cantiere;Descrizione;Imponibile;IVA;Totale;Scadenza pagamento;Pagata il;Stato;Note',
      "Emessa;12/2026;02/11/2026;Mario Bianchi;Villetta;Primo SAL;10000,00;1000,50;11000,50;31/12/2026;20/11/2026;Pagata;'=SOMMA(A1)",
      'Ricevuta;A-77;03/11/2026;Calcestruzzi Srl;;Calcestruzzo;1500,00;330,00;1830,00;;;Da pagare;',
    ])
    const filtered = await s.browser.call('GET', `${url}?filter[direction]=received`)
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect((await s.browser.call('GET', `${url}?filter[status]=late`)).statusCode).toBe(422)
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', `${blind.base}/export`)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', url)).statusCode).toBe(404)
  })

  it('needs the invoices permissions', async () => {
    const owner = await scene()
    const created = await owner.browser.call('POST', owner.base, { body: issued(owner) })
    const id = created.json<Invoice>().id
    const s = await scene(['clients.view'])
    // Same company as the owner's scene is not needed: every check runs before the lookup.
    expect((await s.browser.call('GET', s.base)).statusCode).toBe(403)
    expect((await s.browser.call('GET', `${s.base}/${id}`)).statusCode).toBe(404)
    expect((await s.browser.call('POST', s.base, { body: issued(s) })).statusCode).toBe(403)
    const viewer = await scene(['invoices.view'])
    const mine = await ctx.owner.query<{ id: string }>(
      `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
         taxable_cents, vat_cents) values ($1, 'issued', '9', '2026-11-01', $2, 100, 22)
       returning id`,
      [viewer.company.id, viewer.client],
    )
    const url = `${viewer.base}/${mine.rows[0]?.id}`
    expect((await viewer.browser.call('GET', url)).statusCode).toBe(200)
    const put = await viewer.browser.call('PUT', url, {
      body: issued(viewer),
      headers: { 'If-Match': '"1"' },
    })
    expect(put.statusCode).toBe(403)
    const del = await viewer.browser.call('DELETE', url, { headers: { 'If-Match': '"1"' } })
    expect(del.statusCode).toBe(403)
  })

  it('clients, suppliers and sites with invoices cannot be deleted; the company can', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, { body: issued(s) })
    await s.browser.call('POST', s.base, { body: received(s) })
    const company = `/api/companies/${s.company.slug}`
    // The invoice's deadline also points to the client: delete it, to see the invoice stop it.
    await ctx.owner.query('delete from public.deadlines where company_id = $1', [s.company.id])
    for (const path of [`clients/${s.client}`, `suppliers/${s.supplier}`, `sites/${s.site}`]) {
      const del = await s.browser.call('DELETE', `${company}/${path}`, {
        headers: { 'If-Match': '"1"' },
      })
      expect(del.statusCode).toBe(409)
      expect(del.json()).toMatchObject({ code: 'has_documents' })
    }
    await s.browser.call('POST', s.base, { body: issued(s, { number: '13/2026' }) })
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query('select 1 from public.invoices where company_id = $1', [
      s.company.id,
    ])
    expect(left.rowCount).toBe(0)
  })
})
