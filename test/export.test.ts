import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toCsv } from '../src/csv.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('csv', () => {
  it('quotes separators and neutralises formulas', () => {
    const csv = toCsv(
      ['A', 'B'],
      [
        ['x;y', '=SOMMA(A1)'],
        ['"q"', null],
        [-5, '@a'],
        ['-12,50', '-1+2'],
      ],
    )
    expect(csv).toBe('\uFEFFA;B\r\n"x;y";\'=SOMMA(A1)\r\n"""q""";\r\n-5;\'@a\r\n-12,50;\'-1+2\r\n')
  })
})

describe('clients export', () => {
  it('exports the filtered clients of the company, without pagination', async () => {
    const { company, user } = await fx.companyWithUser(['clients.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}/clients`
    const add = (companyId: string, name: string) =>
      ctx.owner.query(
        "insert into public.clients (company_id, kind, name) values ($1, 'person', $2)",
        [companyId, name],
      )
    for (const name of ['Zeta costruzioni', 'Alfa; Beta srl', '=HYPERLINK("x")']) {
      await add(company.id, name)
    }
    const other = await fx.company()
    await add(other.id, 'Segreto altrui')

    const res = await browser.call('GET', `${base}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toBe('attachment; filename="clienti.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[0]).toMatch(/^Tipo;Nome;Partita IVA;/)
    expect(lines.slice(1).map((l) => l.split(';')[1])).toEqual([
      '"\'=HYPERLINK(""x"")"',
      '"Alfa',
      'Zeta costruzioni',
    ])
    expect(lines[1]).toMatch(/^Privato;/)
    expect(res.body).not.toContain('Segreto altrui')

    const searched = await browser.call('GET', `${base}/export?search=zeta&sort=-name`)
    expect(searched.body.trim().split('\r\n')).toHaveLength(2)
    const bad = await browser.call('GET', `${base}/export?sort=boh`)
    expect(bad.statusCode).toBe(422)
  })

  it('needs clients.view and membership', async () => {
    const { company, user } = await fx.companyWithUser(['suppliers.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const url = `/api/companies/${company.slug}/clients/export`
    expect((await browser.call('GET', url)).statusCode).toBe(403)
    const stranger = await fx.companyWithUser(['clients.view'])
    const s = new Browser(ctx.app)
    await s.signIn(stranger.user.email)
    expect((await s.call('GET', url)).statusCode).toBe(404)
  })
})

describe('suppliers export', () => {
  it('exports the filtered suppliers, with categories and subcontractor flag', async () => {
    const { company, user } = await fx.companyWithUser(['suppliers.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await ctx.owner.query(
      `insert into public.suppliers (company_id, name, categories, subcontractor)
       values ($1, 'Noli Rossi', '{rentals,materials}', false),
              ($1, 'Impianti Neri', '{subcontracting}', true)`,
      [company.id],
    )
    const other = await fx.company()
    await ctx.owner.query(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore altrui')",
      [other.id],
    )
    const url = `/api/companies/${company.slug}/suppliers/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="fornitori.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^Impianti Neri;.*;Subappalto;Sì;$/)
    expect(lines[2]).toMatch(/^Noli Rossi;.*;Noli, Materiali;No;$/)
    expect(res.body).not.toContain('Fornitore altrui')
    const subs = await browser.call('GET', `${url}?filter[subcontractor]=true`)
    expect(subs.body.trim().split('\r\n')).toHaveLength(2)

    const blind = await fx.companyWithUser(['clients.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const forbidden = await b.call('GET', `/api/companies/${blind.company.slug}/suppliers/export`)
    expect(forbidden.statusCode).toBe(403)
    expect((await b.call('GET', url)).statusCode).toBe(404)
  })
})

describe('deadlines export', () => {
  it('exports dates and amounts the Italian way, only for the company', async () => {
    const { company, user } = await fx.companyWithUser(['deadlines.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, recurrence)
       values ($1, 'F24 IVA', '2026-12-16', 'tax', 123450, 'monthly'),
              ($1, 'Revisione furgone', '2026-11-30', 'vehicle', null, null)`,
      [company.id],
    )
    const other = await fx.company()
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind)
       values ($1, 'Scadenza altrui', '2026-11-01', 'other')`,
      [other.id],
    )
    const url = `/api/companies/${company.slug}/deadlines/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="scadenze.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toEqual([
      'Scadenza;Titolo;Tipo;Importo;Cliente;Fornitore;Cantiere;Dipendente;Mezzo;Stato;Ricorrenza;Note',
      '30/11/2026;Revisione furgone;Mezzo;;;;;;;Aperta;;',
      '16/12/2026;F24 IVA;Imposte;1234,50;;;;;;Aperta;Mensile;',
    ])
    const ranged = await browser.call('GET', `${url}?filter[from]=2026-12-01`)
    expect(ranged.body.trim().split('\r\n')).toHaveLength(2)

    const blind = await fx.companyWithUser(['clients.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const denied = await b.call('GET', `/api/companies/${blind.company.slug}/deadlines/export`)
    expect(denied.statusCode).toBe(403)
    expect((await b.call('GET', url)).statusCode).toBe(404)
  })
  it('names the six-month and two-year recurrences in Italian', async () => {
    const { company, user } = await fx.companyWithUser(['deadlines.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await ctx.owner.query(
      `insert into public.deadlines (company_id, title, due_on, kind, recurrence)
       values ($1, 'Estintori', '2026-12-01', 'other', 'semiannual'),
              ($1, 'Revisione autocarro', '2026-12-02', 'vehicle', 'biennial')`,
      [company.id],
    )
    const res = await browser.call('GET', `/api/companies/${company.slug}/deadlines/export`)
    expect(res.body.replace('\uFEFF', '').trim().split('\r\n').slice(1)).toEqual([
      '01/12/2026;Estintori;Altro;;;;;;;Aperta;Semestrale;',
      '02/12/2026;Revisione autocarro;Mezzo;;;;;;;Aperta;Biennale;',
    ])
  })
})

describe('estimates export', () => {
  it('exports estimates with totals, negative ones stay numbers', async () => {
    const { company, user } = await fx.companyWithUser(['estimates.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
      [company.id],
    )
    const est = await ctx.owner.query<{ id: string }>(
      `insert into public.estimates (company_id, title, client_id, site_address, status, updated_at)
       values ($1, 'Bagno', $2, 'Via Roma 1', 'final', '2026-11-30T23:30:00Z'),
              ($1, 'Detrazioni', null, null, 'draft', '2026-11-01T10:00:00Z')
       returning id`,
      [company.id, client.rows[0]?.id],
    )
    const detrazioni = est.rows[1]?.id
    const chapter = await ctx.owner.query<{ id: string }>(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Demolizioni', 0) returning id`,
      [company.id, detrazioni],
    )
    const item = await ctx.owner.query<{ id: string }>(
      `insert into public.estimate_items
         (company_id, estimate_id, chapter_id, description, unit, unit_price_cents, position)
       values ($1, $2, $3, 'Vani', 'm²', 1250, 0) returning id`,
      [company.id, detrazioni, chapter.rows[0]?.id],
    )
    await ctx.owner.query(
      `insert into public.estimate_measurements
         (company_id, estimate_id, item_id, description, equal_parts, position)
       values ($1, $2, $3, 'Porta', -2, 0)`,
      [company.id, detrazioni, item.rows[0]?.id],
    )
    const other = await fx.company()
    await ctx.owner.query(
      "insert into public.estimates (company_id, title) values ($1, 'Computo altrui')",
      [other.id],
    )
    const url = `/api/companies/${company.slug}/estimates/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="computi.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Titolo;Cliente;Indirizzo del lavoro;Stato;Totale;Ultima modifica;Note',
      'Bagno;Mario Bianchi;Via Roma 1;Definitivo;0,00;01/12/2026;',
      'Detrazioni;;;Bozza;-25,00;01/11/2026;',
    ])
    const drafts = await browser.call('GET', `${url}?filter[status]=draft`)
    expect(drafts.body.trim().split('\r\n')).toHaveLength(2)
    expect((await browser.call('GET', `${url}?filter[client]=boh`)).statusCode).toBe(422)

    const blind = await fx.companyWithUser(['quotes.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const denied = await b.call('GET', `/api/companies/${blind.company.slug}/estimates/export`)
    expect(denied.statusCode).toBe(403)
    expect((await b.call('GET', url)).statusCode).toBe(404)
  })
})

describe('quotes export', () => {
  it('exports number, dates and totals of the quotes', async () => {
    const { company, user } = await fx.companyWithUser([
      'quotes.view',
      'quotes.create',
      'quotes.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Anna Verdi') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/quotes`
    const create = async (subject: string) => {
      const res = await browser.call('POST', base, {
        body: {
          client_id: client.rows[0]?.id,
          subject,
          validity_days: 30,
          notes: null,
          terms: null,
        },
      })
      expect(res.statusCode).toBe(201)
      return res.json<{ id: string }>().id
    }
    const sent = await create('Tetto')
    await browser.call('POST', `${base}/${sent}/lines`, {
      body: {
        kind: 'item',
        description: 'Manto',
        unit: 'm²',
        quantity: '10',
        unit_price: '100.00',
        discount_percent: '0',
        vat_rate: 10,
      },
    })
    const send = await browser.call('POST', `${base}/${sent}/send`, {
      headers: { 'if-match': '"1"' },
    })
    expect(send.statusCode).toBe(200)
    const issued = send.json<{ number: string; issue_date: string; valid_until: string }>()
    await create('=Bozza')
    const other = await fx.company()
    const otherClient = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Altro') returning id",
      [other.id],
    )
    await ctx.owner.query(
      "insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'Preventivo altrui')",
      [other.id, otherClient.rows[0]?.id],
    )

    const res = await browser.call('GET', `${base}/export?sort=number`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="preventivi.csv"')
    const it = (iso: string) => iso.split('-').reverse().join('/')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Numero;Data;Cliente;Oggetto;Stato;Valido fino al;Imponibile;IVA;Totale',
      `${issued.number};${it(issued.issue_date)};Anna Verdi;Tetto;Inviato;${it(issued.valid_until)};1000,00;100,00;1100,00`,
      ";;Anna Verdi;'=Bozza;Bozza;;0,00;0,00;0,00",
    ])
    const drafts = await browser.call('GET', `${base}/export?filter[status]=sent`)
    expect(drafts.body.trim().split('\r\n')).toHaveLength(2)

    const blind = await fx.companyWithUser(['estimates.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const denied = await b.call('GET', `/api/companies/${blind.company.slug}/quotes/export`)
    expect(denied.statusCode).toBe(403)
    expect((await b.call('GET', `${base}/export`)).statusCode).toBe(404)
  })
})
