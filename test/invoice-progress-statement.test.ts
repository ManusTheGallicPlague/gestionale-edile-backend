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

const ALL: Permission[] = ['invoices.view', 'invoices.create', 'invoices.update', 'estimates.view']

/** A company with a site, its estimate, an approved SAL n. 1 and a draft SAL n. 2. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string, params: unknown[] = [company.id]) =>
    (await ctx.owner.query<{ id: string }>(sql, params)).rows[0]?.id ?? ''
  const client = await one(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
  )
  const site = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1') returning id",
  )
  const otherSite = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Box', 'C-2') returning id",
  )
  const estimate = await one(
    "insert into public.estimates (company_id, title, site_id) values ($1, 'Villetta', $2) returning id",
    [company.id, site],
  )
  const approved = await one(
    `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
       status, approved_at) values ($1, $2, 1, '2026-10-31', 'approved', now()) returning id`,
    [company.id, estimate],
  )
  const draft = await one(
    `insert into public.progress_statements (company_id, estimate_id, number, statement_date)
     values ($1, $2, 2, '2026-11-30') returning id`,
    [company.id, estimate],
  )
  const slug = company.slug
  const invoice = (overrides: Record<string, unknown> = {}) => ({
    direction: 'issued',
    number: `${Math.floor(Math.random() * 1_000_000)}/2026`,
    date: '2026-11-02',
    client_id: client,
    supplier_id: null,
    site_id: site,
    description: 'SAL n. 1',
    taxable_amount: '10000.00',
    vat_amount: '1000.00',
    due_date: null,
    paid_on: null,
    notes: null,
    progress_statement_id: approved,
    ...overrides,
  })
  return {
    browser,
    company,
    site,
    otherSite,
    approved,
    draft,
    invoice,
    base: `/api/companies/${slug}/invoices`,
    statementUrl: (id: string) =>
      `/api/companies/${slug}/estimates/${estimate}/progress-statements/${id}`,
  }
}

describe('invoice of a progress statement', () => {
  it('the invoice of a SAL is not the release of the retention', async () => {
    const s = await scene()
    const bad = await s.browser.call('POST', s.base, {
      body: s.invoice({ retention_release: true }),
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors)).toEqual(['retention_release'])
    const release = await s.browser.call('POST', s.base, {
      body: s.invoice({ number: '2/2026', progress_statement_id: null, retention_release: true }),
    })
    expect(release.statusCode).toBe(201)
    const { id } = release.json<{ id: string }>()
    const linked = await s.browser.call('PUT', `${s.base}/${id}`, {
      body: s.invoice({ number: '2/2026' }),
      headers: { 'if-match': '"1"' },
    })
    expect(linked.statusCode).toBe(422)
    expect(Object.keys(linked.json<{ errors: object }>().errors)).toEqual(['retention_release'])
  })

  it('links an issued invoice to an approved SAL, shown on both sides, once', async () => {
    const s = await scene()
    const res = await s.browser.call('POST', s.base, { body: s.invoice() })
    expect(res.statusCode).toBe(201)
    const invoice = res.json<{ id: string; progress_statement_id: string | null }>()
    expect(invoice.progress_statement_id).toBe(s.approved)
    const statement = await s.browser.call('GET', s.statementUrl(s.approved))
    expect(statement.statusCode).toBe(200)
    expect(statement.json<{ invoice_id: string | null }>().invoice_id).toBe(invoice.id)
    const again = await s.browser.call('POST', s.base, { body: s.invoice() })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({
      errors: { progress_statement_id: ['Questo SAL è già stato fatturato.'] },
    })
  })

  it('keeps the link when absent on update, removes it with null', async () => {
    const s = await scene()
    const created = (await s.browser.call('POST', s.base, { body: s.invoice() })).json<{
      id: string
      number: string
    }>()
    const url = `${s.base}/${created.id}`
    const body = s.invoice({ number: created.number, notes: 'Pagamento a 60 giorni' })
    delete (body as Record<string, unknown>).progress_statement_id
    const kept = await s.browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toMatchObject({ progress_statement_id: s.approved })
    const removed = await s.browser.call('PUT', url, {
      body: { ...body, progress_statement_id: null },
      headers: { 'if-match': '"2"' },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toMatchObject({ progress_statement_id: null })
    const statement = await s.browser.call('GET', s.statementUrl(s.approved))
    expect(statement.json<{ invoice_id: string | null }>().invoice_id).toBeNull()
  })

  it('refuses a draft SAL, a SAL of another site and a received invoice', async () => {
    const s = await scene()
    const field = async (body: object) => {
      const res = await s.browser.call('POST', s.base, { body })
      expect(res.statusCode).toBe(422)
      return res.json<{ errors: Record<string, string[]> }>().errors.progress_statement_id
    }
    expect(await field(s.invoice({ progress_statement_id: s.draft }))).toEqual([
      'Si fattura solo un SAL approvato.',
    ])
    expect(await field(s.invoice({ site_id: s.otherSite }))).toEqual([
      'Il SAL è di un altro cantiere.',
    ])
    const supplier = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
      [s.company.id],
    )
    expect(
      await field(
        s.invoice({ direction: 'received', client_id: null, supplier_id: supplier.rows[0]?.id }),
      ),
    ).toEqual(['Si collega un SAL solo a una fattura emessa.'])
    // Without a site on the invoice any SAL of the company goes.
    const res = await s.browser.call('POST', s.base, { body: s.invoice({ site_id: null }) })
    expect(res.statusCode).toBe(201)
  })

  it('refuses turning a linked invoice into a received one without unlinking it', async () => {
    const s = await scene()
    const created = (await s.browser.call('POST', s.base, { body: s.invoice() })).json<{
      id: string
    }>()
    const supplier = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
      [s.company.id],
    )
    const body = s.invoice({
      direction: 'received',
      client_id: null,
      supplier_id: supplier.rows[0]?.id,
    })
    delete (body as Record<string, unknown>).progress_statement_id
    const res = await s.browser.call('PUT', `${s.base}/${created.id}`, {
      body,
      headers: { 'if-match': '"1"' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('does not reach a SAL of another company', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('POST', mine.base, {
      body: mine.invoice({ site_id: null, progress_statement_id: theirs.approved }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { progress_statement_id: ['SAL non trovato.'] } })
  })

  it('lets a whole company with a billed SAL be deleted', async () => {
    const s = await scene()
    expect((await s.browser.call('POST', s.base, { body: s.invoice() })).statusCode).toBe(201)
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query('select 1 from public.progress_statements where id = $1', [
      s.approved,
    ])
    expect(left.rowCount).toBe(0)
  })
})
