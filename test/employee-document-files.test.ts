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

const ALL: Permission[] = ['employees.view', 'employees.update']
const PDF = Buffer.from('%PDF-1.4\n% attestato\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Rossi') returning id",
    [company.id],
  )
  const employee = rows[0]?.id ?? ''
  const docs = await ctx.owner.query<{ id: string }>(
    `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
     values ($1, $2, 'safety_training', '2027-03-01') returning id`,
    [company.id, employee],
  )
  const document = docs.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/employees/${employee}/documents`
  const fileUrl = `${base}/${document}/file`
  const upload = (
    body: Buffer,
    type = 'application/pdf',
    version = '"1"',
    query = 'file_name=Attestato%202026.pdf',
    b: Browser = browser,
  ) =>
    b.call('PUT', `${fileUrl}?${query}`, {
      body,
      headers: { 'content-type': type, 'if-match': version },
    })
  return { browser, company, employee, document, base, fileUrl, upload }
}

type Doc = {
  id: string
  file: { file_name: string; content_type: string; size: number; uploaded_at: string } | null
}

describe('files of employee documents', () => {
  it('attaches, downloads, replaces and removes the file', async () => {
    const s = await scene()
    const list = await s.browser.call('GET', s.base)
    expect(list.json<{ data: Doc[] }>().data[0]?.file).toBeNull()
    expect((await s.browser.call('GET', s.fileUrl)).statusCode).toBe(404)

    const saved = await s.upload(PDF)
    expect(saved.statusCode).toBe(200)
    expect(saved.headers.etag).toBe('"2"')
    expect(saved.json<Doc>().file).toMatchObject({
      file_name: 'Attestato 2026.pdf',
      content_type: 'application/pdf',
      size: PDF.length,
    })
    const listed = await s.browser.call('GET', s.base)
    expect(listed.json<{ data: Doc[] }>().data[0]?.file?.file_name).toBe('Attestato 2026.pdf')

    const content = await s.browser.call('GET', s.fileUrl)
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.equals(PDF)).toBe(true)
    expect(content.headers['content-type']).toBe('application/pdf')
    expect(content.headers['content-disposition']).toContain(
      'attachment; filename="Attestato 2026.pdf"',
    )
    expect(content.headers['x-content-type-options']).toBe('nosniff')

    // The old version is stale; the new one replaces the file.
    expect((await s.upload(PNG, 'image/png')).statusCode).toBe(412)
    const replaced = await s.upload(PNG, 'image/png', '"2"', 'file_name=C:%5Cscan%5Cattestato.png')
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json<Doc>().file).toMatchObject({
      file_name: 'attestato.png',
      size: PNG.length,
    })
    const count = await ctx.owner.query(
      'select 1 from public.employee_document_files where document_id = $1',
      [s.document],
    )
    expect(count.rowCount).toBe(1)

    // Editing the document keeps the file.
    const edited = await s.browser.call('PUT', `${s.base}/${s.document}`, {
      body: {
        kind: 'safety_training',
        description: null,
        issued_on: null,
        expires_on: '2027-04-01',
        notes: null,
      },
      headers: { 'if-match': '"3"' },
    })
    expect(edited.statusCode).toBe(200)
    expect(edited.json<Doc>().file?.file_name).toBe('attestato.png')

    expect((await s.browser.call('DELETE', s.fileUrl)).statusCode).toBe(428)
    expect(
      (await s.browser.call('DELETE', s.fileUrl, { headers: { 'if-match': '"3"' } })).statusCode,
    ).toBe(412)
    const removed = await s.browser.call('DELETE', s.fileUrl, { headers: { 'if-match': '"4"' } })
    expect(removed.statusCode).toBe(200)
    expect(removed.headers.etag).toBe('"5"')
    expect(removed.json<Doc>().file).toBeNull()
    // Nothing left to remove: 404, and the version does not move.
    expect(
      (await s.browser.call('DELETE', s.fileUrl, { headers: { 'if-match': '"5"' } })).statusCode,
    ).toBe(404)
    expect((await s.upload(PDF, 'application/pdf', '"5"')).statusCode).toBe(200)
  })

  it('refuses files that do not match their type, and missing names', async () => {
    const s = await scene()
    expect((await s.upload(PNG, 'application/pdf')).statusCode).toBe(422)
    expect((await s.upload(Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415)
    const noName = await s.upload(PDF, 'application/pdf', '"1"', 'x=1')
    expect(noName.statusCode).toBe(422)
    expect(noName.json<{ errors: Record<string, string[]> }>().errors).toHaveProperty('file_name')
    const big = await s.upload(Buffer.alloc(20 * 1024 * 1024 + 1, 0x25), 'application/pdf')
    expect(big.statusCode).toBe(413)
    expect((await s.upload(PDF, 'application/pdf', '')).statusCode).toBe(428)
  })

  it('follows the permissions and the CSRF check', async () => {
    const reader = await scene(['employees.view'])
    expect((await reader.upload(PDF)).statusCode).toBe(403)
    expect(
      (await reader.browser.call('DELETE', reader.fileUrl, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(403)
    const nobody = await scene([])
    expect((await nobody.browser.call('GET', nobody.fileUrl)).statusCode).toBe(404)

    const s = await scene()
    const res = await s.browser.request('PUT', `${s.fileUrl}?file_name=a.pdf`, {
      body: PDF,
      headers: { 'content-type': 'application/pdf', 'if-match': '"1"' },
      csrf: false,
    })
    expect(res.statusCode).toBe(403)
    const stranger = new Browser(ctx.app)
    expect(
      (await s.upload(PDF, 'application/pdf', '"1"', 'file_name=a.pdf', stranger)).statusCode,
    ).toBe(401)
  })

  it('never shows or touches the file of another company', async () => {
    const a = await scene()
    const b = await scene()
    expect((await b.upload(PDF)).statusCode).toBe(200)
    // B's document through A's company, and A's company with B's employee: always 404.
    const crossed = `/api/companies/${a.company.slug}/employees/${b.employee}/documents/${b.document}/file`
    expect((await a.browser.call('GET', crossed)).statusCode).toBe(404)
    expect(
      (
        await a.browser.call('PUT', `${crossed}?file_name=x.pdf`, {
          body: PDF,
          headers: { 'content-type': 'application/pdf', 'if-match': '"2"' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (await a.browser.call('DELETE', crossed, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(404)
    // B's document under A's own employee.
    const mixed = `${a.base}/${b.document}/file`
    expect((await a.browser.call('GET', mixed)).statusCode).toBe(404)
    const still = await b.browser.call('GET', b.fileUrl)
    expect(still.rawPayload.equals(PDF)).toBe(true)
  })

  it('goes away with the document', async () => {
    const s = await scene()
    expect((await s.upload(PDF)).statusCode).toBe(200)
    const del = await s.browser.call('DELETE', `${s.base}/${s.document}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(del.statusCode).toBe(204)
    const left = await ctx.owner.query(
      'select 1 from public.employee_document_files where document_id = $1',
      [s.document],
    )
    expect(left.rowCount).toBe(0)
  })
})
