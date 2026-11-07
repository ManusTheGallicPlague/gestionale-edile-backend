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
  'sites.view',
  'quotes.view',
  'estimates.view',
  'invoices.view',
  'purchases.view',
  'employees.view',
  'vehicles.view',
  'deadlines.view',
  'price_lists.view',
  'documents.view',
  'warehouse.view',
]

interface Hit {
  type: string
  id: string
  parent_id: string | null
  title: string
  subtitle: string | null
}
interface Results {
  q: string
  items: Hit[]
}

/** A company with one of everything named «Rossi», plus a user with the given permissions. */
async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const id = company.id
  const q = (sql: string, values: unknown[] = []) =>
    ctx.owner.query<{ id: string }>(sql, [id, ...values])
  const client = await q(
    `insert into public.clients (company_id, kind, name, city) values
       ($1, 'person', 'Mario Rossi', 'Verona') returning id`,
  )
  await q(
    `insert into public.clients (company_id, kind, name, archived_at) values
       ($1, 'person', 'Rossi archiviato', now())`,
  )
  const supplier = await q(
    `insert into public.suppliers (company_id, name, city) values
       ($1, 'Ferramenta Rossi', 'Padova') returning id`,
  )
  const site = await q(
    `insert into public.sites (company_id, name, code, address) values
       ($1, 'Villa sul lago', '2026-07', 'Via Rossi 3, Verona') returning id`,
  )
  await q(
    `insert into public.quotes (company_id, client_id, subject, status, number_year, number_seq, revision,
       issue_date) values ($1, $2, 'Tetto Rossi', 'sent', 2026, 42, 0, '2026-11-02')`,
    [client.rows[0]?.id],
  )
  await q(
    `insert into public.estimates (company_id, title, client_id) values
       ($1, 'Computo casa Rossi', $2)`,
    [client.rows[0]?.id],
  )
  await q(
    `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
       description, taxable_cents, vat_cents, due_date)
     values ($1, 'issued', 'FT-77', '2026-11-02', $2, 'Acconto lavori Rossi', 10000, 1000,
       '2026-12-02')`,
    [client.rows[0]?.id],
  )
  await q(
    `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
       order_date) values ($1, 2026, 5, $2, '2026-11-02')`,
    [supplier.rows[0]?.id],
  )
  await q(
    `insert into public.employees (company_id, first_name, last_name, job_title) values
       ($1, 'Luca', 'Rossi', 'Muratore')`,
  )
  await q(
    `insert into public.vehicles (company_id, name, kind, plate) values
       ($1, 'Escavatore Rossi', 'machine', 'AB123CD')`,
  )
  await q(
    `insert into public.deadlines (company_id, title, due_on, kind) values
       ($1, 'DURC Ferramenta Rossi', '2026-12-31', 'durc')`,
  )

  const priceList = await q(
    "insert into public.price_lists (company_id, name) values ($1, 'Prezzario 2026') returning id",
  )
  await q(
    `insert into public.price_list_items (company_id, price_list_id, code, description, unit,
       unit_price_cents) values ($1, $2, 'ROSSI.01', 'Intonaco civile', 'm²', 1850)`,
    [priceList.rows[0]?.id],
  )
  await q(
    `insert into public.site_documents (company_id, site_id, kind, title, file_name,
       content_type, size_bytes) values ($1, $2, 'document', 'Contratto', 'contratto-rossi.pdf',
       'application/pdf', 100)`,
    [site.rows[0]?.id],
  )
  await q(
    `insert into public.warehouse_items (company_id, code, name, unit)
     values ($1, 'ROSSI-T', 'Tavole da ponte', 'pz')`,
  )
  await q(
    `insert into public.site_activities (company_id, site_id, name, start_on, end_on)
     values ($1, $2, 'Intonaci casa Rossi', '2026-11-02', '2026-11-20')`,
    [site.rows[0]?.id],
  )

  const user = await fx.user()
  await fx.member(user.id, id, await fx.role(id, 'Ricerca', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return {
    browser,
    company,
    url: `/api/companies/${company.slug}/search`,
    siteId: site.rows[0]?.id,
    priceListId: priceList.rows[0]?.id,
  }
}

describe('quick search', () => {
  it('finds every type the user may see, in the contract order', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.url}?q=${encodeURIComponent(' rOSSi ')}`)
    expect(res.statusCode).toBe(200)
    const body = res.json<Results>()
    expect(body.q).toBe('rOSSi')
    expect(body.items.map((h) => [h.type, h.title, h.subtitle])).toEqual([
      ['client', 'Mario Rossi', 'Verona'],
      ['supplier', 'Ferramenta Rossi', 'Padova'],
      ['site', 'Villa sul lago', '2026-07'],
      ['quote', 'Tetto Rossi', '2026/042'],
      ['estimate', 'Computo casa Rossi', 'Mario Rossi'],
      ['invoice', 'FT-77', 'Acconto lavori Rossi'],
      ['purchase_order', '2026/005', 'Ferramenta Rossi'],
      ['employee', 'Rossi Luca', 'Muratore'],
      ['vehicle', 'Escavatore Rossi', 'AB123CD'],
      ['deadline', 'DURC Ferramenta Rossi', '31/12/2026'],
      ['price_list_item', 'Intonaco civile', 'ROSSI.01'],
      ['site_document', 'Contratto', 'Villa sul lago'],
      ['warehouse_item', 'Tavole da ponte', 'ROSSI-T'],
      ['site_activity', 'Intonaci casa Rossi', 'Villa sul lago'],
    ])
    const parent = (type: string) => body.items.find((h) => h.type === type)?.parent_id
    expect(parent('price_list_item')).toBe(s.priceListId)
    expect(parent('site_document')).toBe(s.siteId)
    expect(parent('site_activity')).toBe(s.siteId)
    expect(parent('client')).toBeNull()
  })

  it('finds quotes and orders by number, employees by first name first, vehicles by plate', async () => {
    const s = await scene()
    const types = async (q: string) =>
      (await s.browser.call('GET', `${s.url}?q=${encodeURIComponent(q)}`))
        .json<Results>()
        .items.map((h) => [h.type, h.title])
    expect(await types('2026/042')).toEqual([['quote', 'Tetto Rossi']])
    expect(await types('2026/005')).toEqual([['purchase_order', '2026/005']])
    expect(await types('luca rossi')).toEqual([['employee', 'Rossi Luca']])
    expect(await types('ab123')).toEqual([['vehicle', 'Escavatore Rossi']])
    expect(await types('rossi-t')).toEqual([['warehouse_item', 'Tavole da ponte']])
  })

  it('treats % and _ as plain characters', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', `${s.url}?q=${encodeURIComponent('%_')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<Results>().items).toEqual([])
  })

  it('puts titles starting with the text first and keeps 5 per type', async () => {
    const s = await scene()
    for (const name of ['Zeta Rossi', 'Alfa Rossi', 'Rossini', 'Beta Rossi', 'Gamma Rossi']) {
      await ctx.owner.query(
        "insert into public.clients (company_id, kind, name) values ($1, 'person', $2)",
        [s.company.id, name],
      )
    }
    const res = await s.browser.call('GET', `${s.url}?q=rossi`)
    const clients = res
      .json<Results>()
      .items.filter((h) => h.type === 'client')
      .map((h) => h.title)
    expect(clients).toEqual(['Rossini', 'Alfa Rossi', 'Beta Rossi', 'Gamma Rossi', 'Mario Rossi'])
  })

  it('leaves out the types the user may not see', async () => {
    const s = await scene(['sites.view', 'deadlines.view'])
    const res = await s.browser.call('GET', `${s.url}?q=rossi`)
    expect(res.statusCode).toBe(200)
    expect(res.json<Results>().items.map((h) => h.type)).toEqual([
      'site',
      'deadline',
      'site_activity',
    ])

    const none = await scene([])
    const empty = await none.browser.call('GET', `${none.url}?q=rossi`)
    expect(empty.statusCode).toBe(200)
    expect(empty.json<Results>().items).toEqual([])
  })

  it('never shows data of another company', async () => {
    const mine = await scene()
    const other = await scene()
    const res = await mine.browser.call('GET', `${mine.url}?q=rossi`)
    const ids = res.json<Results>().items.map((h) => h.id)
    const theirs = await ctx.owner.query<{ id: string }>(
      `select id from public.clients where company_id = $1
       union all select id from public.site_activities where company_id = $1`,
      [other.company.id],
    )
    expect(theirs.rows).toHaveLength(3) // Two clients and one activity.
    expect(ids).toHaveLength(14)
    for (const row of theirs.rows) expect(ids).not.toContain(row.id)

    const cross = await mine.browser.call('GET', `${other.url}?q=rossi`)
    expect(cross.statusCode).toBe(404)
  })

  it('rejects a missing, short, long or repeated text', async () => {
    const s = await scene()
    for (const query of ['', '?q=', '?q=%20a%20', `?q=${'x'.repeat(101)}`, '?q=ab&q=cd']) {
      const res = await s.browser.call('GET', `${s.url}${query}`)
      expect(res.statusCode, query).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors.q).toHaveLength(1)
    }
  })

  it('wants a session', async () => {
    const s = await scene()
    const res = await new Browser(ctx.app).call('GET', `${s.url}?q=rossi`)
    expect(res.statusCode).toBe(401)
  })
})
