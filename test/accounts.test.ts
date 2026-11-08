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
  'suppliers.view',
  'invoices.view',
  'invoices.create',
  'invoices.update',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Amministrazione', permissions)
  await fx.member(user.id, company.id, role)
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
  const supplier = await insert(
    "insert into public.suppliers (company_id, name) values ($1, 'Laterizi di prova') returning id",
  )
  const base = `/api/companies/${company.slug}`
  return { browser, company, client, other, supplier, base }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function invoice(s: Scene, browser: Browser, overrides: Record<string, unknown>) {
  const res = await browser.call('POST', `${s.base}/invoices`, {
    body: {
      direction: 'issued',
      number: `F-${Math.random().toString(36).slice(2, 8)}`,
      date: '2026-01-10',
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
  return res.json<{ id: string }>()
}

describe('statement of account', () => {
  it('sums the issued invoices of a client: paid, partly paid, overdue', async () => {
    const s = await scene()
    // Paid in full, with no payment registered: all settled.
    await invoice(s, s.browser, { paid_on: '2026-01-20', due_date: '2026-01-31' })
    // Overdue, with an advance: only the rest is overdue.
    const late = await invoice(s, s.browser, { due_date: '2026-02-28' })
    const pay = await s.browser.call('POST', `${s.base}/invoices/${late.id}/payments`, {
      body: { date: '2026-02-10', amount: '200.50', method: null, notes: null },
      headers: { 'If-Match': '"1"' },
    })
    expect(pay.statusCode).toBe(200)
    // Not yet due, with withholding and split payment: amount due without both.
    await invoice(s, s.browser, {
      taxable_amount: '500',
      vat_amount: '110',
      withholding_amount: '100',
      split_payment: true,
    })
    // Another client's and a received invoice do not count.
    await invoice(s, s.browser, { client_id: s.other })
    await invoice(s, s.browser, { direction: 'received', client_id: null, supplier_id: s.supplier })

    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      invoice_count: 3,
      open_invoice_count: 2,
      total: '3050.00',
      amount_due: '2840.00',
      settled: '1420.50',
      outstanding: '1419.50',
      overdue: '1019.50',
    })
  })

  it('sums the received invoices of a supplier; zero without invoices', async () => {
    const s = await scene()
    const empty = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)
    expect(empty.json()).toEqual({
      invoice_count: 0,
      open_invoice_count: 0,
      total: '0.00',
      amount_due: '0.00',
      settled: '0.00',
      outstanding: '0.00',
      overdue: '0.00',
    })
    await invoice(s, s.browser, {
      direction: 'received',
      client_id: null,
      supplier_id: s.supplier,
      taxable_amount: '99.99',
      vat_amount: '22',
      due_date: '2026-03-01',
    })
    const res = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)
    expect(res.json()).toMatchObject({
      invoice_count: 1,
      total: '121.99',
      outstanding: '121.99',
      overdue: '121.99',
      settled: '0.00',
    })
  })

  it('works for an archived client', async () => {
    const s = await scene()
    await invoice(s, s.browser, {})
    await ctx.owner.query('update public.clients set archived_at = now() where id = $1', [s.client])
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ invoice_count: 1, outstanding: '1220.00' })
  })

  it('is 404 for another company, an unknown id or without the view permission', async () => {
    const s = await scene()
    const t = await scene()
    await invoice(t, t.browser, {})
    // The other company's client, through our company and through theirs.
    expect((await s.browser.call('GET', `${s.base}/clients/${t.client}/account`)).statusCode).toBe(
      404,
    )
    expect((await s.browser.call('GET', `${t.base}/clients/${t.client}/account`)).statusCode).toBe(
      404,
    )
    expect(
      (await s.browser.call('GET', `${s.base}/suppliers/${t.supplier}/account`)).statusCode,
    ).toBe(404)
    expect(
      (
        await s.browser.call(
          'GET',
          `${s.base}/clients/00000000-0000-4000-8000-000000000000/account`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await s.browser.call('GET', `${s.base}/clients/nope/account`)).statusCode).toBe(404)

    const blind = await scene(['invoices.view', 'suppliers.view'])
    expect(
      (await blind.browser.call('GET', `${blind.base}/clients/${blind.client}/account`)).statusCode,
    ).toBe(404)
  })

  it('is 403 without invoices.view and 401 without a session', async () => {
    const s = await scene(['clients.view', 'suppliers.view'])
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account`)
    expect(res.statusCode).toBe(403)
    expect(
      (await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account`)).statusCode,
    ).toBe(403)
    const anon = new Browser(ctx.app)
    expect((await anon.call('GET', `${s.base}/clients/${s.client}/account`)).statusCode).toBe(401)
  })

  it('prints the open invoices of a client as a payment reminder', async () => {
    const s = await scene()
    await ctx.owner.query(
      `update public.clients set vat_number = '01234567897', street = 'Via Po 2',
         postal_code = '14100', city = 'Asti', province = 'AT' where id = $1`,
      [s.client],
    )
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, iban)
       values ($1, 'Edilizia di prova Srl', 'IT60X0542811101000000123456')
       on conflict (company_id) do update set iban = excluded.iban`,
      [s.company.id],
    )
    const url = `${s.base}/clients/${s.client}/account/pdf`
    const empty = await s.browser.call('GET', url)
    expect(empty.statusCode).toBe(200)
    expect(empty.rawPayload.toString('latin1')).toContain('(Nessuna fattura da incassare.)')

    await invoice(s, s.browser, { number: 'F-PAGATA', paid_on: '2026-01-20' })
    await invoice(s, s.browser, { number: 'F-NUOVA', date: '2026-03-01', due_date: '2099-12-31' })
    const late = await invoice(s, s.browser, { number: 'F-VECCHIA', due_date: '2026-02-28' })
    await s.browser.call('POST', `${s.base}/invoices/${late.id}/payments`, {
      body: { date: '2026-02-10', amount: '200.50', method: null, notes: null },
      headers: { 'If-Match': '"1"' },
    })
    await invoice(s, s.browser, { number: 'F-ALTRO', client_id: s.other })

    const res = await s.browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('attachment; filename="estratto-conto.pdf"')
    const text = res.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain('(Estratto conto)')
    expect(text).toContain('(Mario Bianchi)')
    expect(text).toContain('(P. IVA 01234567897)')
    expect(text).toContain('(14100 Asti \\(AT\\))')
    // The oldest due date first; paid invoices and other clients' are left out.
    expect(text.indexOf('(F-VECCHIA)')).toBeGreaterThan(0)
    expect(text.indexOf('(F-VECCHIA)')).toBeLessThan(text.indexOf('(F-NUOVA)'))
    expect(text).not.toContain('(F-PAGATA)')
    expect(text).not.toContain('(F-ALTRO)')
    expect(text).toContain('(28/02/2026 scaduta)')
    expect(text).toContain('(31/12/2099)')
    expect(text).toContain('(200,50)')
    expect(text).toContain('(1.019,50)')
    expect(text).toContain('(\x80 2.239,50)')
    expect(text).toContain('(\x80 1.019,50)')
    expect(text).toContain('(Per il pagamento: IBAN IT60X0542811101000000123456)')

    // Another company, without invoices.view, without clients.view, without a session.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (await theirs.browser.call('GET', `${theirs.base}/clients/${s.client}/account/pdf`))
        .statusCode,
    ).toBe(404)
    const noInvoices = await scene(['clients.view'])
    expect(
      (
        await noInvoices.browser.call(
          'GET',
          `${noInvoices.base}/clients/${noInvoices.client}/account/pdf`,
        )
      ).statusCode,
    ).toBe(403)
    const noClients = await scene(['invoices.view'])
    expect(
      (
        await noClients.browser.call(
          'GET',
          `${noClients.base}/clients/${noClients.client}/account/pdf`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })

  it('prints the open invoices of a supplier, archived too, to check the balance', async () => {
    const s = await scene()
    await ctx.owner.query(
      `update public.suppliers set vat_number = '01234567897', street = 'Via Roma 5',
         postal_code = '10121', city = 'Torino', province = 'TO', archived_at = now()
       where id = $1`,
      [s.supplier],
    )
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, iban)
       values ($1, 'Edilizia di prova Srl', 'IT60X0542811101000000123456')
       on conflict (company_id) do update set iban = excluded.iban`,
      [s.company.id],
    )
    const other = (
      await ctx.owner.query<{ id: string }>(
        "insert into public.suppliers (company_id, name) values ($1, 'Noli di prova') returning id",
        [s.company.id],
      )
    ).rows[0]?.id
    const received = { direction: 'received', client_id: null, supplier_id: s.supplier }
    const url = `${s.base}/suppliers/${s.supplier}/account/pdf`
    const empty = await s.browser.call('GET', url)
    expect(empty.statusCode).toBe(200)
    expect(empty.rawPayload.toString('latin1')).toContain('(Nessuna fattura da pagare.)')

    await invoice(s, s.browser, { ...received, number: 'A-PAGATA', paid_on: '2026-01-20' })
    await invoice(s, s.browser, { ...received, number: 'A-NUOVA', due_date: '2099-12-31' })
    const late = await invoice(s, s.browser, {
      ...received,
      number: 'A-VECCHIA',
      due_date: '2026-02-28',
    })
    const pay = await s.browser.call('POST', `${s.base}/invoices/${late.id}/payments`, {
      body: { date: '2026-02-10', amount: '200.50', method: null, notes: null },
      headers: { 'If-Match': '"1"' },
    })
    expect(pay.statusCode).toBe(200)
    await invoice(s, s.browser, { ...received, number: 'A-ALTRO', supplier_id: other })
    // An issued invoice is never in a supplier's statement.
    await invoice(s, s.browser, { number: 'F-EMESSA' })

    const res = await s.browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('attachment; filename="estratto-conto.pdf"')
    const text = res.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain('(Estratto conto)')
    expect(text).toContain('(Laterizi di prova)')
    expect(text).toContain('(P. IVA 01234567897)')
    expect(text).toContain('(10121 Torino \\(TO\\))')
    expect(text.indexOf('(A-VECCHIA)')).toBeGreaterThan(0)
    expect(text.indexOf('(A-VECCHIA)')).toBeLessThan(text.indexOf('(A-NUOVA)'))
    expect(text).not.toContain('(A-PAGATA)')
    expect(text).not.toContain('(A-ALTRO)')
    expect(text).not.toContain('(F-EMESSA)')
    expect(text).toContain('(28/02/2026 scaduta)')
    expect(text).toContain('(Gi\xe0 pagato)')
    expect(text).toContain('(Totale da pagare)')
    expect(text).toContain('(\x80 2.239,50)')
    expect(text).toContain('(\x80 1.019,50)')
    expect(text).toContain(
      '(Vi chiediamo di verificare il saldo e di segnalarci eventuali differenze.)',
    )
    // The company's IBAN is for clients who pay, not for a supplier.
    expect(text).not.toContain('IT60X0542811101000000123456')
    expect(text).not.toContain('incassare')

    // Another company, a client's id, without invoices.view, without suppliers.view, signed out.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (await theirs.browser.call('GET', `${theirs.base}/suppliers/${s.supplier}/account/pdf`))
        .statusCode,
    ).toBe(404)
    expect(
      (await s.browser.call('GET', `${s.base}/suppliers/${s.client}/account/pdf`)).statusCode,
    ).toBe(404)
    const noInvoices = await scene(['suppliers.view'])
    expect(
      (
        await noInvoices.browser.call(
          'GET',
          `${noInvoices.base}/suppliers/${noInvoices.supplier}/account/pdf`,
        )
      ).statusCode,
    ).toBe(403)
    const noSuppliers = await scene(['invoices.view'])
    expect(
      (
        await noSuppliers.browser.call(
          'GET',
          `${noSuppliers.base}/suppliers/${noSuppliers.supplier}/account/pdf`,
        )
      ).statusCode,
    ).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })

  it('lists the balance of each client, highest first, with totals of all pages', async () => {
    const s = await scene()
    const third = (
      await ctx.owner.query<{ id: string }>(
        "insert into public.clients (company_id, kind, name, archived_at) values ($1, 'person', 'Bruno Neri', now()) returning id",
        [s.company.id],
      )
    ).rows[0]?.id
    await invoice(s, s.browser, { due_date: '2026-02-28' })
    await invoice(s, s.browser, { taxable_amount: '10', vat_amount: '0', due_date: '2026-03-01' })
    await invoice(s, s.browser, { paid_on: '2026-01-20' })
    await invoice(s, s.browser, { client_id: s.other, taxable_amount: '5000', vat_amount: '0' })
    // Archived, with no due date: still listed, never overdue.
    await invoice(s, s.browser, { client_id: third, due_date: null, taxable_amount: '1230' })
    // A received invoice does not count.
    await invoice(s, s.browser, { direction: 'received', client_id: null, supplier_id: s.supplier })

    const base = `${s.base}/clients/balances`
    const res = await s.browser.call('GET', base)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        {
          subject: { id: s.other, name: 'Anna Verdi' },
          open_invoice_count: 1,
          outstanding: '5000.00',
          overdue: '0.00',
          oldest_due_date: '2099-12-31',
        },
        {
          subject: { id: third, name: 'Bruno Neri' },
          open_invoice_count: 1,
          outstanding: '1450.00',
          overdue: '0.00',
          oldest_due_date: null,
        },
        {
          subject: { id: s.client, name: 'Mario Bianchi' },
          open_invoice_count: 2,
          outstanding: '1230.00',
          overdue: '1230.00',
          oldest_due_date: '2026-02-28',
        },
      ],
      meta: { total: 3, page: 1, per_page: 25 },
      outstanding: '7680.00',
      overdue: '1230.00',
    })

    const second = await s.browser.call('GET', `${base}?page=2&per_page=2`)
    expect(second.json()).toMatchObject({
      data: [{ subject: { id: s.client } }],
      meta: { total: 3, page: 2, per_page: 2 },
      outstanding: '7680.00',
    })
    // Past the last page: no rows, the same totals.
    const past = await s.browser.call('GET', `${base}?page=9`)
    expect(past.json()).toEqual({
      data: [],
      meta: { total: 3, page: 9, per_page: 25 },
      outstanding: '7680.00',
      overdue: '1230.00',
    })
    expect((await s.browser.call('GET', `${base}?per_page=101`)).statusCode).toBe(422)

    // Only those with something overdue, with their own totals.
    const late = await s.browser.call('GET', `${base}?filter[overdue]=true`)
    expect(late.json()).toEqual({
      data: [
        {
          subject: { id: s.client, name: 'Mario Bianchi' },
          open_invoice_count: 2,
          outstanding: '1230.00',
          overdue: '1230.00',
          oldest_due_date: '2026-02-28',
        },
      ],
      meta: { total: 1, page: 1, per_page: 25 },
      outstanding: '1230.00',
      overdue: '1230.00',
    })
    expect((await s.browser.call('GET', `${base}?filter[overdue]=false`)).json()).toMatchObject({
      meta: { total: 3 },
    })
    expect((await s.browser.call('GET', `${base}?filter[overdue]=si`)).statusCode).toBe(422)

    const suppliers = await s.browser.call('GET', `${s.base}/suppliers/balances`)
    expect(suppliers.json()).toMatchObject({
      data: [{ subject: { id: s.supplier, name: 'Laterizi di prova' }, outstanding: '1220.00' }],
      meta: { total: 1 },
    })

    // Another company sees none of these; their own lists are empty.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', base)).statusCode).toBe(404)
    expect((await theirs.browser.call('GET', `${theirs.base}/clients/balances`)).json()).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25 },
      outstanding: '0.00',
      overdue: '0.00',
    })
  })

  it('lists balances only with both view permissions', async () => {
    const noInvoices = await scene(['clients.view', 'suppliers.view'])
    expect(
      (await noInvoices.browser.call('GET', `${noInvoices.base}/clients/balances`)).statusCode,
    ).toBe(403)
    const noClients = await scene(['invoices.view', 'suppliers.view'])
    expect(
      (await noClients.browser.call('GET', `${noClients.base}/clients/balances`)).statusCode,
    ).toBe(403)
    expect(
      (await noClients.browser.call('GET', `${noClients.base}/suppliers/balances`)).statusCode,
    ).toBe(200)
    const anon = new Browser(ctx.app)
    expect((await anon.call('GET', `${noClients.base}/clients/balances`)).statusCode).toBe(401)
  })

  it('exports the balances as CSV, in the same order', async () => {
    const s = await scene()
    await invoice(s, s.browser, {
      due_date: '2026-02-28',
      taxable_amount: '1000.5',
      vat_amount: '0',
    })
    await invoice(s, s.browser, { client_id: s.other, taxable_amount: '5000', vat_amount: '0' })
    await ctx.owner.query("update public.clients set name = '=SOMMA(1;2)' where id = $1", [s.other])
    const res = await s.browser.call('GET', `${s.base}/clients/balances/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="crediti-clienti.csv"')
    const rows = res.body.replace(/^\uFEFF/, '').split('\r\n')
    expect(rows[0]).toBe('Cliente;Fatture aperte;Scadenza più vecchia;Da incassare;Di cui scaduto')
    expect(rows[1]).toMatch(/^"?'=SOMMA\(1;2\)"?;1;31\/12\/2099;5000,00;0,00$/)
    expect(rows[2]).toBe('Mario Bianchi;1;28/02/2026;1000,50;1000,50')
    expect(rows).toHaveLength(4)
    const late = await s.browser.call(
      'GET',
      `${s.base}/clients/balances/export?filter[overdue]=true`,
    )
    expect(late.body.replace(/^\uFEFF/, '').split('\r\n')).toHaveLength(3)
    expect(
      (await s.browser.call('GET', `${s.base}/clients/balances/export?filter[overdue]=1`))
        .statusCode,
    ).toBe(422)

    const suppliers = await s.browser.call('GET', `${s.base}/suppliers/balances/export`)
    expect(suppliers.headers['content-disposition']).toBe(
      'attachment; filename="debiti-fornitori.csv"',
    )
    expect(suppliers.body.replace(/^\uFEFF/, '')).toBe(
      'Fornitore;Fatture aperte;Scadenza più vecchia;Da pagare;Di cui scaduto\r\n',
    )

    const theirs = await scene()
    expect((await theirs.browser.call('GET', `${s.base}/clients/balances/export`)).statusCode).toBe(
      404,
    )
    const noInvoices = await scene(['clients.view'])
    expect(
      (await noInvoices.browser.call('GET', `${noInvoices.base}/clients/balances/export`))
        .statusCode,
    ).toBe(403)
  })
})
