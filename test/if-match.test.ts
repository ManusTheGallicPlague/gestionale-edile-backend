/**
 * If-Match on every change that takes a body: a stale version answers 412 before the body
 * is validated (it used to be 422 on most routes), and the weak form W/"n" that a
 * compressing proxy makes of our ETags names the same version (it used to be 412 always).
 * The scene is the development data, which has a record of every kind.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { seedDev } from '../scripts/seed-dev.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let browser: Browser
let companyId = ''
let base = ''

beforeAll(async () => {
  ctx = await startApp()
  // Other test files leave their companies behind: this is not a development database.
  await seedDev(inject('testDb').owner, { force: true })
  const fx = new Fixtures(ctx.owner)
  const { rows } = await ctx.owner.query<{ company: string; role: string }>(
    `select c.id as company, r.id as role from public.companies c
     join public.roles r on r.company_id = c.id and r.name = 'Titolare'
     where c.slug = 'impresa-rossi'`,
  )
  companyId = rows[0]?.company ?? ''
  // Estimates in draft: a final one refuses every change to its structure with a 409.
  await ctx.owner.query("update public.estimates set status = 'draft' where company_id = $1", [
    companyId,
  ])
  const user = await fx.user()
  await fx.member(user.id, companyId, rows[0]?.role ?? '')
  browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  base = '/api/companies/impresa-rossi'
})
afterAll(() => ctx.close())

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

interface Case {
  method: 'PUT' | 'POST'
  /** Path after /api/companies/{company}, with {column} filled from the row of `sql`. */
  path: string
  /** One row of the company ($1) with the path columns and the current `version`. */
  sql: string
  /** A body that fails validation; a Buffer is sent as a PDF. */
  body?: unknown
}

const json = (method: Case['method'], path: string, sql: string, body: unknown = {}): Case => ({
  method,
  path,
  sql,
  body,
})
const one = (table: string, columns = 'id') =>
  `select ${columns}, version from public.${table} where company_id = $1 order by id limit 1`
const BAD_STATUS = { status: 'nessuno' }

const CASES: Case[] = [
  json('PUT', '/clients/{id}', one('clients')),
  json('PUT', '/suppliers/{id}', one('suppliers')),
  json(
    'PUT',
    '/suppliers/{supplier}/documents/{id}',
    one('supplier_documents', 'id, supplier_id as supplier'),
  ),
  json(
    'PUT',
    '/suppliers/{supplier}/documents/{id}/file?file_name=a.pdf',
    one('supplier_documents', 'id, supplier_id as supplier'),
    PNG,
  ),
  json('PUT', '/deadlines/{id}', one('deadlines')),
  json('PUT', '/estimates/{id}', one('estimates')),
  json(
    'PUT',
    '/estimates/{id}/structure',
    'select id, structure_version as version from public.estimates where company_id = $1 order by id limit 1',
    { chapters: 'no' },
  ),
  json(
    'PUT',
    '/estimates/{estimate}/chapters/{id}',
    one('estimate_chapters', 'id, estimate_id as estimate'),
  ),
  json(
    'PUT',
    '/estimates/{estimate}/items/{id}',
    one('estimate_items', 'id, estimate_id as estimate'),
  ),
  json(
    'PUT',
    '/estimates/{estimate}/measurements/{id}',
    one('estimate_measurements', 'id, estimate_id as estimate'),
  ),
  json(
    'PUT',
    '/estimates/{estimate}/progress-statements/{id}',
    one('progress_statements', 'id, estimate_id as estimate'),
  ),
  json('PUT', '/quotes/{id}', one('quotes')),
  json('POST', '/quotes/{id}/status', one('quotes'), BAD_STATUS),
  json(
    'PUT',
    '/quotes/{quote}/lines/{id}',
    `select l.id, l.quote_id as quote, l.version from public.quote_lines l
     join public.quotes q on q.id = l.quote_id
     where l.company_id = $1 and q.status = 'draft' order by l.id limit 1`,
  ),
  json('PUT', '/sites/{id}', one('sites')),
  json('PUT', '/sites/{site}/activities/{id}', one('site_activities', 'id, site_id as site')),
  json('PUT', '/sites/{site}/documents/{id}', one('site_documents', 'id, site_id as site')),
  json('PUT', '/employees/{id}', one('employees')),
  json(
    'PUT',
    '/employees/{employee}/absences/{id}',
    one('employee_absences', 'id, employee_id as employee'),
  ),
  json(
    'PUT',
    '/employees/{employee}/documents/{id}',
    one('employee_documents', 'id, employee_id as employee'),
  ),
  json(
    'PUT',
    '/employees/{employee}/documents/{id}/file?file_name=a.pdf',
    one('employee_documents', 'id, employee_id as employee'),
    PNG,
  ),
  json('PUT', '/vehicles/{id}', one('vehicles')),
  json(
    'PUT',
    '/vehicles/{vehicle}/maintenances/{id}',
    one('vehicle_maintenances', 'id, vehicle_id as vehicle'),
  ),
  json(
    'PUT',
    '/vehicles/{vehicle}/refuelings/{id}',
    one('vehicle_refuelings', 'id, vehicle_id as vehicle'),
  ),
  json(
    'PUT',
    '/vehicles/{vehicle}/documents/{id}',
    one('vehicle_documents', 'id, vehicle_id as vehicle'),
  ),
  json(
    'PUT',
    '/vehicles/{vehicle}/documents/{id}/file?file_name=a.pdf',
    one('vehicle_documents', 'id, vehicle_id as vehicle'),
    PNG,
  ),
  json('PUT', '/daily-reports/{id}', one('daily_reports')),
  json('POST', '/daily-reports/{id}/status', one('daily_reports'), BAD_STATUS),
  json('PUT', '/costs/{id}', one('site_costs')),
  json('PUT', '/purchase-orders/{id}', one('purchase_orders')),
  json('POST', '/purchase-orders/{id}/status', one('purchase_orders'), BAD_STATUS),
  json('PUT', '/invoices/{id}', one('invoices')),
  json('POST', '/invoices/{id}/payments', one('invoices')),
  json('PUT', '/invoices/{id}/file?file_name=a.pdf', one('invoices'), PNG),
  json('PUT', '/warehouse/items/{id}', one('warehouse_items')),
  json('PUT', '/price-lists/{id}', one('price_lists')),
  json(
    'PUT',
    '/price-lists/{list}/items/{id}',
    one('price_list_items', 'id, price_list_id as list'),
  ),
  json(
    'PUT',
    '/settings/company',
    'select version from public.company_profiles where company_id = $1',
  ),
]

async function target(c: Case) {
  const { rows } = await ctx.owner.query<Record<string, string | number>>(c.sql, [companyId])
  const row = rows[0]
  if (!row) throw new Error(`no row for ${c.path}`)
  const path = c.path.replace(/\{(\w+)\}/g, (_, column: string) => String(row[column]))
  return { url: `${base}${path}`, version: Number(row.version) }
}

function send(c: Case, url: string, ifMatch: string) {
  if (Buffer.isBuffer(c.body)) {
    return browser.call(c.method, url, {
      body: c.body,
      headers: { 'if-match': ifMatch, 'content-type': 'application/pdf' },
    })
  }
  return browser.call(c.method, url, { body: c.body ?? {}, headers: { 'if-match': ifMatch } })
}

describe('If-Match', () => {
  it.each(CASES.map((c) => [`${c.method} ${c.path}`, c] as const))(
    '%s: 412 before 422',
    async (_label, c) => {
      const { url, version } = await target(c)
      const stale = await send(c, url, `"${version + 1000}"`)
      expect(stale.statusCode, stale.body).toBe(412)
      expect(stale.json()).toMatchObject({ code: 'stale_record' })
      // The weak form of the right version passes the check and reaches the body (or the
      // state of the record, for a progress statement already approved).
      const weak = await send(c, url, `W/"${version}"`)
      expect([409, 422], weak.body).toContain(weak.statusCode)
    },
  )

  it('accepts the weak form of the ETag for a real change', async () => {
    const { rows } = await ctx.owner.query<{ id: string; version: number }>(
      one('warehouse_items'),
      [companyId],
    )
    const item = rows[0]
    if (!item) throw new Error('no warehouse item')
    const url = `${base}/warehouse/items/${item.id}`
    const current = await browser.call('GET', url)
    const body = current.json<Record<string, unknown>>()
    const weak = `W/${current.headers.etag as string}`
    const res = await browser.call('PUT', url, {
      body: {
        code: body.code,
        name: 'Nome cambiato',
        unit: body.unit,
        notes: body.notes,
        min_stock: body.min_stock,
      },
      headers: { 'if-match': weak },
    })
    expect(res.statusCode, res.body).toBe(200)
    // The ETag the API sends stays strong.
    expect(res.headers.etag).toBe(`"${item.version + 1}"`)
    // Anything else is still not one of our versions.
    for (const header of ['w/"1"', 'W/1', '"1', '*']) {
      const refused = await browser.call('PUT', url, { body: {}, headers: { 'if-match': header } })
      expect(refused.statusCode).toBe(412)
    }
  })
})
