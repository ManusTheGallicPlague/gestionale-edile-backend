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

async function scene(permissions: Permission[] = ['sites.view', 'clients.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const clientId = await client(company.id, 'Rossi')
  return {
    browser,
    company,
    clientId,
    url: `/api/companies/${company.slug}/clients/${clientId}/sites`,
  }
}

async function client(companyId: string, name: string, archived = false) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.clients (company_id, kind, name, archived_at)
     values ($1, 'person', $2, case when $3 then now() end) returning id`,
    [companyId, name, archived],
  )
  return rows[0]?.id ?? ''
}

async function site(
  companyId: string,
  name: string,
  status: string,
  clientId: string | null,
  code: string | null = null,
) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name, status, client_id, code)
     values ($1, $2, $3, $4, $5) returning id`,
    [companyId, name, status, clientId, code],
  )
  return rows[0]?.id ?? ''
}

async function invoice(
  companyId: string,
  siteId: string,
  clientId: string,
  taxable: number,
  vat = 0,
  paid = false,
) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
       site_id, taxable_cents, vat_cents, paid_on)
     values ($1, 'issued', (floor(random() * 1e9)::bigint + 1)::text, '2026-11-02', $2, $3,
       $4, $5, case when $6 then '2026-11-04'::date end)
     returning id`,
    [companyId, clientId, siteId, taxable, vat, paid],
  )
  return rows[0]?.id ?? ''
}

async function payment(companyId: string, invoiceId: string, cents: number) {
  await ctx.owner.query(
    `insert into public.invoice_payments (invoice_id, company_id, payment_date, amount_cents)
     values ($1, $2, '2026-11-03', $3)`,
    [invoiceId, companyId, cents],
  )
}

async function quote(companyId: string, clientId: string, siteId: string) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.quotes (company_id, client_id, subject, validity_days, status,
       number_year, number_seq, revision, issue_date, sent_at)
     values ($1, $2, 'Rifacimento del tetto', 30, 'accepted', 2026,
       floor(random() * 1e6)::int + 1, 0, '2026-11-02', now())
     returning id`,
    [companyId, clientId],
  )
  const quoteId = rows[0]?.id ?? ''
  // 120.5 × 18.40 = 2217.20 and 1250.00 less 20% = 1000.00; the section does not count.
  await ctx.owner.query(
    `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
       unit_price_cents, discount_percent, vat_rate, position)
     values ($1, $2, 'item', 'Rimozione del manto', 'm²', 120.5, 1840, 0, 10, 0),
            ($1, $2, 'item', 'Lattonerie', 'a corpo', 1, 125000, 20, 22, 1),
            ($1, $2, 'section', 'Note', null, null, null, null, null, 2)`,
    [companyId, quoteId],
  )
  await ctx.owner.query('update public.sites set quote_id = $2 where id = $1', [siteId, quoteId])
}

const row = (siteId: string, name: string, status: string, code: string | null = null) => ({
  site_id: siteId,
  code,
  name,
  status,
  quoted: null,
  invoiced: null,
  collected: null,
  to_collect: null,
})

describe('sites of a client', () => {
  it('lists the client’s sites and those with an invoice to it, in progress first', async () => {
    const { browser, company, clientId, url } = await scene()
    const other = await client(company.id, 'Bianchi')
    const closed = await site(company.id, 'Arena', 'completed', other)
    const active = await site(company.id, 'Villetta', 'active', clientId, 'C-01')
    const planned = await site(company.id, 'Box', 'planned', clientId)
    const suspended = await site(company.id, 'Scuola', 'suspended', clientId)
    const unrelated = await site(company.id, 'Niente', 'active', other)
    await site(company.id, 'Senza cliente', 'active', null)
    await invoice(company.id, closed, clientId, 987654)
    await invoice(company.id, unrelated, other, 987654)

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        row(active, 'Villetta', 'active', 'C-01'),
        row(planned, 'Box', 'planned'),
        row(suspended, 'Scuola', 'suspended'),
        row(closed, 'Arena', 'completed'),
      ],
    })
    expect(res.body).not.toMatch(/9876[.,]54/)

    const theirs = await browser.call('GET', url.replace(clientId, other))
    expect(theirs.json()).toEqual({
      data: [row(unrelated, 'Niente', 'active'), row(closed, 'Arena', 'completed')],
    })
  })

  it('adds invoiced, collected and to collect on each site with invoices.view', async () => {
    const { browser, company, clientId, url } = await scene([
      'sites.view',
      'clients.view',
      'invoices.view',
    ])
    const other = await client(company.id, 'Bianchi')
    const own = await site(company.id, 'Villetta', 'active', clientId)
    const empty = await site(company.id, 'Box', 'planned', clientId)
    const foreign = await site(company.id, 'Arena', 'completed', other)
    // 0.10 with 0.04 paid in advance, plus 0.20 paid: 0.30 invoiced, 0.24 collected, 0.06 left.
    const open = await invoice(company.id, own, clientId, 10)
    await payment(company.id, open, 4)
    await invoice(company.id, own, clientId, 20, 0, true)
    // An invoice to another client on the same site does not count, nor a received one.
    await invoice(company.id, own, other, 50000)
    const supplier = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore') returning id",
      [company.id],
    )
    await ctx.owner.query(
      `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         site_id, taxable_cents, vat_cents)
       values ($1, 'received', 'F-1', '2026-11-02', $2, $3, 70000, 15400)`,
      [company.id, supplier.rows[0]?.id, own],
    )
    // On a site of another client, with VAT: 100.00 invoiced, 122.00 to collect.
    await invoice(company.id, foreign, clientId, 10000, 2200)

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        {
          ...row(own, 'Villetta', 'active'),
          invoiced: '0.30',
          collected: '0.24',
          to_collect: '0.06',
        },
        {
          ...row(empty, 'Box', 'planned'),
          invoiced: '0.00',
          collected: '0.00',
          to_collect: '0.00',
        },
        {
          ...row(foreign, 'Arena', 'completed'),
          invoiced: '100.00',
          collected: '0.00',
          to_collect: '122.00',
        },
      ],
    })
  })

  it('adds the taxable amount of the quote the site came from, with quotes.view', async () => {
    const { browser, company, clientId, url } = await scene([
      'sites.view',
      'clients.view',
      'quotes.view',
    ])
    const fromQuote = await site(company.id, 'Tetto', 'active', clientId)
    await quote(company.id, clientId, fromQuote)
    const plain = await site(company.id, 'Box', 'planned', clientId)
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { ...row(fromQuote, 'Tetto', 'active'), quoted: '3217.20' },
        row(plain, 'Box', 'planned'),
      ],
    })
    const csv = await browser.call('GET', `${url}/export`)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Codice;Cantiere;Stato;Preventivo',
      ';Tetto;In corso;3217,20',
      ';Box;Da iniziare;',
    ])

    // Without quotes.view the amount is not there.
    const other = await scene()
    const s = await site(other.company.id, 'Tetto', 'active', other.clientId)
    await quote(other.company.id, other.clientId, s)
    const hidden = await other.browser.call('GET', other.url)
    expect(hidden.json()).toEqual({ data: [row(s, 'Tetto', 'active')] })
    expect(hidden.body).not.toMatch(/3217[.,]20/)
  })

  it('exports the same sites in CSV, with the amounts only with invoices.view', async () => {
    const all = await scene(['sites.view', 'clients.view', 'invoices.view'])
    const a = await site(all.company.id, 'Villetta; "nord"', 'active', all.clientId, 'C-01')
    const b = await site(all.company.id, 'Arena', 'completed', all.clientId)
    await invoice(all.company.id, a, all.clientId, 10)
    await invoice(all.company.id, a, all.clientId, 20, 0, true)
    await invoice(all.company.id, b, all.clientId, 123456, 27160)

    const res = await all.browser.call('GET', `${all.url}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="cantieri-cliente.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Codice;Cantiere;Stato;Fatturato;Incassato;Da incassare',
      'C-01;"Villetta; ""nord""";In corso;0,30;0,20;0,10',
      ';Arena;Chiuso;1234,56;0,00;1506,16',
    ])

    const plain = await scene()
    const c = await site(plain.company.id, 'Box', 'planned', plain.clientId)
    await invoice(plain.company.id, c, plain.clientId, 987654)
    const csv = await plain.browser.call('GET', `${plain.url}/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).not.toMatch(/9876[.,]54/)
    expect(csv.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Codice;Cantiere;Stato',
      ';Box;Da iniziare',
    ])
  })

  it('works for an archived client', async () => {
    const { browser, company } = await scene()
    const archived = await client(company.id, 'Archiviato', true)
    const s = await site(company.id, 'Villetta', 'completed', archived)
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/clients/${archived}/sites`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [row(s, 'Villetta', 'completed')] })
  })

  it('needs clients.view (404) and sites.view (403), for the list and the CSV', async () => {
    for (const suffix of ['', '/export']) {
      const office = await scene(['clients.view', 'invoices.view'])
      expect((await office.browser.call('GET', office.url + suffix)).statusCode).toBe(403)
      const chief = await scene(['sites.view', 'invoices.view'])
      expect((await chief.browser.call('GET', chief.url + suffix)).statusCode).toBe(404)
      const mine = await scene()
      expect(
        (await mine.browser.call('GET', mine.url.replace(mine.clientId, 'nope') + suffix))
          .statusCode,
      ).toBe(404)
      expect(
        (
          await mine.browser.call(
            'GET',
            mine.url.replace(mine.clientId, '00000000-0000-4000-8000-000000000000') + suffix,
          )
        ).statusCode,
      ).toBe(404)
      expect((await new Browser(ctx.app).call('GET', mine.url + suffix)).statusCode).toBe(401)
    }
  })

  it('does not show another company’s client, sites or invoices', async () => {
    const mine = await scene(['sites.view', 'clients.view', 'invoices.view'])
    const theirs = await scene(['sites.view', 'clients.view', 'invoices.view'])
    const s = await site(theirs.company.id, 'Loro', 'active', theirs.clientId)
    await invoice(theirs.company.id, s, theirs.clientId, 999)
    const other = `/api/companies/${mine.company.slug}/clients/${theirs.clientId}/sites`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    expect((await mine.browser.call('GET', `${other}/export`)).statusCode).toBe(404)
    expect((await mine.browser.call('GET', mine.url)).json()).toEqual({ data: [] })
    const own = await site(mine.company.id, 'Mio', 'active', mine.clientId)
    await invoice(mine.company.id, own, mine.clientId, 100)
    expect((await mine.browser.call('GET', mine.url)).json()).toEqual({
      data: [
        { ...row(own, 'Mio', 'active'), invoiced: '1.00', collected: '0.00', to_collect: '1.00' },
      ],
    })
    expect((await theirs.browser.call('GET', theirs.url)).json()).toEqual({
      data: [
        { ...row(s, 'Loro', 'active'), invoiced: '9.99', collected: '0.00', to_collect: '9.99' },
      ],
    })
  })
})
