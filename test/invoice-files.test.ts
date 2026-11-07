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

const ALL: Permission[] = ['invoices.view', 'invoices.update', 'invoices.delete', 'audit.view']
const PDF = Buffer.from('%PDF-1.4\n% fattura\n%%EOF\n')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const supplier = await ctx.owner.query<{ id: string }>(
    "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
    [company.id],
  )
  const invoice = await ctx.owner.query<{ id: string }>(
    `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
       taxable_cents, vat_cents)
     values ($1, 'received', 'A/7', '2026-11-02', $2, 100000, 22000) returning id`,
    [company.id, supplier.rows[0]?.id],
  )
  const id = invoice.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/invoices`
  const fileUrl = `${base}/${id}/file`
  const upload = (
    body: Buffer,
    type = 'application/pdf',
    version = '"1"',
    query = 'file_name=fattura-A7.pdf',
    b: Browser = browser,
    url = fileUrl,
  ) =>
    b.call('PUT', `${url}?${query}`, {
      body,
      headers: { 'content-type': type, 'if-match': version },
    })
  return { browser, company, id, base, fileUrl, upload }
}

type Invoice = { id: string; file: { file_name: string; size: number } | null }

describe('PDF of registered invoices', () => {
  it('attaches, downloads, replaces and removes the file', async () => {
    const s = await scene()
    const first = await s.browser.call('GET', `${s.base}/${s.id}`)
    expect(first.json<Invoice>().file).toBeNull()
    expect((await s.browser.call('GET', s.fileUrl)).statusCode).toBe(404)

    const saved = await s.upload(PDF)
    expect(saved.statusCode).toBe(200)
    expect(saved.headers.etag).toBe('"2"')
    expect(saved.json<Invoice>().file).toMatchObject({
      file_name: 'fattura-A7.pdf',
      size: PDF.length,
    })
    const list = await s.browser.call('GET', s.base)
    expect(list.json<{ data: Invoice[] }>().data[0]?.file?.file_name).toBe('fattura-A7.pdf')

    const content = await s.browser.call('GET', s.fileUrl)
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.equals(PDF)).toBe(true)
    expect(content.headers['content-disposition']).toContain('filename="fattura-A7.pdf"')
    expect(content.headers['content-security-policy']).toBe("default-src 'none'; sandbox")

    expect((await s.upload(JPEG, 'image/jpeg')).statusCode).toBe(412)
    const replaced = await s.upload(JPEG, 'image/jpeg', '"2"', 'file_name=scansione.jpg')
    expect(replaced.json<Invoice>().file).toMatchObject({ file_name: 'scansione.jpg' })

    // Only the version moves: the audit log does not record the file.
    const audit = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/audit-log?filter[entity]=invoice&filter[entity_id]=${s.id}`,
    )
    expect(audit.statusCode).toBe(200)
    const actions = audit.json<{ data: { action: string }[] }>().data.map((e) => e.action)
    expect(actions).not.toContain('update')

    expect((await s.browser.call('DELETE', s.fileUrl)).statusCode).toBe(428)
    const removed = await s.browser.call('DELETE', s.fileUrl, { headers: { 'if-match': '"3"' } })
    expect(removed.statusCode).toBe(200)
    expect(removed.json<Invoice>().file).toBeNull()
    expect(
      (await s.browser.call('DELETE', s.fileUrl, { headers: { 'if-match': '"4"' } })).statusCode,
    ).toBe(404)
    // The 404 above did not take a version.
    expect((await s.upload(PDF, 'application/pdf', '"4"')).statusCode).toBe(200)
  })

  it('refuses wrong files and follows the permissions', async () => {
    const s = await scene()
    expect((await s.upload(JPEG, 'application/pdf')).statusCode).toBe(422)
    expect((await s.upload(PDF, 'application/octet-stream')).statusCode).toBe(415)
    expect((await s.upload(PDF, 'application/pdf', '"1"', 'title=x')).statusCode).toBe(422)

    const reader = await scene(['invoices.view'])
    expect((await reader.upload(PDF)).statusCode).toBe(403)
    const nobody = await scene([])
    expect((await nobody.browser.call('GET', nobody.fileUrl)).statusCode).toBe(404)
    const stranger = new Browser(ctx.app)
    expect(
      (await s.upload(PDF, 'application/pdf', '"1"', 'file_name=a.pdf', stranger)).statusCode,
    ).toBe(401)
  })

  it('never shows or touches the file of another company', async () => {
    const a = await scene()
    const b = await scene()
    expect((await b.upload(PDF)).statusCode).toBe(200)
    const crossed = `${a.base}/${b.id}/file`
    expect((await a.browser.call('GET', crossed)).statusCode).toBe(404)
    expect(
      (await a.upload(PDF, 'application/pdf', '"2"', 'file_name=x.pdf', a.browser, crossed))
        .statusCode,
    ).toBe(404)
    expect(
      (await a.browser.call('DELETE', crossed, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(404)
    expect((await b.browser.call('GET', b.fileUrl)).rawPayload.equals(PDF)).toBe(true)
  })

  it('goes away with the invoice', async () => {
    const s = await scene()
    expect((await s.upload(PDF)).statusCode).toBe(200)
    const del = await s.browser.call('DELETE', `${s.base}/${s.id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(del.statusCode).toBe(204)
    const left = await ctx.owner.query('select 1 from public.invoice_files where invoice_id = $1', [
      s.id,
    ])
    expect(left.rowCount).toBe(0)
  })
})
