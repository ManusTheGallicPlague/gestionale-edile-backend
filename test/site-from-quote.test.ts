import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
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
  'quotes.view',
  'quotes.create',
  'quotes.update',
  'sites.view',
  'sites.create',
  'sites.update',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

type Quote = { id: string; status: string; number: string | null; site_id: string | null }
type Site = {
  id: string
  name: string
  status: string
  budget: string | null
  client: { id: string; name: string } | null
  quote: { id: string; number: string | null } | null
}

/** A company with an accepted quote of 2217.20 + 1000.00 taxable (IVA 10% and 22%). */
async function scene(permissions: Permission[] = ALL, accept = true) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Condominio Aurora', $2) returning id",
    [company.id, newVat()],
  )
  const clientId = client.rows[0]?.id ?? ''
  const quote = await ctx.owner.query<{ id: string }>(
    `insert into public.quotes (company_id, client_id, subject, validity_days, status,
       number_year, number_seq, revision, issue_date, sent_at)
     values ($1, $2, 'Rifacimento del tetto', 30, $3, 2026, 7, 0, '2026-11-02', now())
     returning id`,
    [company.id, clientId, accept ? 'accepted' : 'sent'],
  )
  const quoteId = quote.rows[0]?.id ?? ''
  await ctx.owner.query(
    `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
       unit_price_cents, discount_percent, vat_rate, position)
     values ($1, $2, 'item', 'Rimozione del manto', 'm²', 120.5, 1840, 0, 10, 0),
            ($1, $2, 'item', 'Lattonerie', 'a corpo', 1, 125000, 20, 22, 1),
            ($1, $2, 'section', 'Note', null, null, null, null, null, 2)`,
    [company.id, quoteId],
  )
  const quoteUrl = `/api/companies/${company.slug}/quotes/${quoteId}`
  return { browser, company, clientId, quoteId, quoteUrl, url: `${quoteUrl}/site` }
}

describe('site from quote', () => {
  it('creates a planned site with client and budget from an accepted quote, once', async () => {
    const { browser, clientId, quoteId, quoteUrl, url, company } = await scene()
    const res = await browser.call('POST', url)
    expect(res.statusCode).toBe(201)
    expect(res.headers.etag).toBe('"1"')
    const site = res.json<Site>()
    // 120.5 × 18.40 = 2217.20; 1250.00 − 20% = 1000.00: budget is the taxable total.
    expect(site).toMatchObject({
      name: 'Rifacimento del tetto',
      status: 'planned',
      budget: '3217.20',
      client: { id: clientId, name: 'Condominio Aurora' },
      quote: { id: quoteId, number: '2026/007' },
    })
    const quote = (await browser.call('GET', quoteUrl)).json<Quote>()
    expect(quote.site_id).toBe(site.id)
    const again = await browser.call('POST', url)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'site_exists' })
    const read = await browser.call('GET', `/api/companies/${company.slug}/sites/${site.id}`)
    expect(read.json<Site>().quote).toEqual({ id: quoteId, number: '2026/007' })
  })

  it('keeps the link when the site is updated', async () => {
    const { browser, company, quoteId, url } = await scene()
    const site = (await browser.call('POST', url)).json<Site>()
    const put = await browser.call('PUT', `/api/companies/${company.slug}/sites/${site.id}`, {
      body: {
        code: 'C-07',
        name: 'Tetto Aurora',
        client_id: null,
        address: 'Via dei Tigli 4, Torino',
        status: 'active',
        start_on: '2026-11-16',
        end_on: null,
        budget: '3500.00',
        notes: null,
      },
      headers: { 'if-match': '"1"' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json<Site>().quote?.id).toBe(quoteId)
  })

  it('leaves the budget empty when the taxable total is negative', async () => {
    const { browser, company, quoteId, url } = await scene()
    await ctx.owner.query(
      `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
         unit_price_cents, discount_percent, vat_rate, position)
       values ($1, $2, 'item', 'Detrazione', 'a corpo', -1, 500000, 0, 10, 3)`,
      [company.id, quoteId],
    )
    const res = await browser.call('POST', url)
    expect(res.statusCode).toBe(201)
    expect(res.json<Site>().budget).toBeNull()
  })

  it('only works for accepted quotes', async () => {
    const { browser, url } = await scene(ALL, false)
    const res = await browser.call('POST', url)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'invalid_transition' })
  })

  it('needs quotes.view (404) and sites.create (403)', async () => {
    const blind = await scene(['sites.view', 'sites.create'])
    expect((await blind.browser.call('POST', blind.url)).statusCode).toBe(404)
    const reader = await scene(['quotes.view', 'sites.view'])
    expect((await reader.browser.call('POST', reader.url)).statusCode).toBe(403)
    const missing = await scene()
    const unknown = missing.url.replace(missing.quoteId, '00000000-0000-4000-8000-000000000000')
    expect((await missing.browser.call('POST', unknown)).statusCode).toBe(404)
  })

  it('does not reach a quote of another company', async () => {
    const mine = await scene()
    const theirs = await scene()
    const url = `/api/companies/${mine.company.slug}/quotes/${theirs.quoteId}/site`
    expect((await mine.browser.call('POST', url)).statusCode).toBe(404)
    const quote = await ctx.owner.query('select 1 from public.sites where quote_id = $1', [
      theirs.quoteId,
    ])
    expect(quote.rowCount).toBe(0)
  })

  it('lets a whole company with a site from a quote be deleted', async () => {
    const s = await scene()
    expect((await s.browser.call('POST', s.url)).statusCode).toBe(201)
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query('select 1 from public.quotes where id = $1', [s.quoteId])
    expect(left.rowCount).toBe(0)
  })
})
