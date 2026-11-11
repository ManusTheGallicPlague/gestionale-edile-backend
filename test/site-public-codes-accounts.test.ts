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
  const school = await insert(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const house = await insert(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  const base = `/api/companies/${company.slug}`
  return { browser, company, client, other, supplier, school, house, base }
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

describe('CIG and CUP of the site in the statement of account', () => {
  it('are printed under the invoice of a public works site, for the client', async () => {
    const s = await scene()
    await invoice(s, s.browser, { number: 'F-SCUOLA', site_id: s.school })
    await invoice(s, s.browser, { number: 'F-VILLETTA', site_id: s.house })
    await invoice(s, s.browser, { number: 'F-NESSUNO' })
    const res = await s.browser.call('GET', `${s.base}/clients/${s.client}/account/pdf`)
    expect(res.statusCode).toBe(200)
    const text = res.rawPayload.toString('latin1')
    expect(text).toContain('(F-SCUOLA)')
    expect(text).toContain('(F-VILLETTA)')
    expect(text).toContain('(F-NESSUNO)')
    // Once, right after its invoice.
    expect(text.split('(CIG 12345ABCDE - CUP B12C34000560007)')).toHaveLength(2)
    expect(text.indexOf('(CIG 12345ABCDE')).toBeGreaterThan(text.indexOf('(F-SCUOLA)'))

    await ctx.owner.query('update public.sites set cig = null where id = $1', [s.school])
    const onlyCup = (
      await s.browser.call('GET', `${s.base}/clients/${s.client}/account/pdf`)
    ).rawPayload.toString('latin1')
    expect(onlyCup).toContain('(CUP B12C34000560007)')
    expect(onlyCup).not.toContain('CIG')
  })

  it('leave the PDF unchanged without codes', async () => {
    const s = await scene()
    await invoice(s, s.browser, { number: 'F-VILLETTA', site_id: s.house })
    const text = (
      await s.browser.call('GET', `${s.base}/clients/${s.client}/account/pdf`)
    ).rawPayload.toString('latin1')
    expect(text).toContain('(F-VILLETTA)')
    expect(text).not.toContain('CIG')
    expect(text).not.toContain('CUP')
  })

  it('are printed for the supplier too', async () => {
    const s = await scene()
    await invoice(s, s.browser, {
      direction: 'received',
      number: 'R-SCUOLA',
      client_id: null,
      supplier_id: s.supplier,
      site_id: s.school,
    })
    const res = await s.browser.call('GET', `${s.base}/suppliers/${s.supplier}/account/pdf`)
    expect(res.statusCode).toBe(200)
    const text = res.rawPayload.toString('latin1')
    expect(text).toContain('(R-SCUOLA)')
    expect(text).toContain('(CIG 12345ABCDE - CUP B12C34000560007)')
  })

  it('are not printed for another company, nor without the permissions', async () => {
    const s = await scene()
    await invoice(s, s.browser, { number: 'F-SCUOLA', site_id: s.school })
    const theirs = await scene()
    const other = await theirs.browser.call('GET', `${theirs.base}/clients/${s.client}/account/pdf`)
    expect(other.statusCode).toBe(404)
    expect(other.rawPayload.toString('latin1')).not.toContain('12345ABCDE')
    const blind = await scene(['clients.view'])
    expect(
      (await blind.browser.call('GET', `${blind.base}/clients/${blind.client}/account/pdf`))
        .statusCode,
    ).toBe(403)
  })
})
