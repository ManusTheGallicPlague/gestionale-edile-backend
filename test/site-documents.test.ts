import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { cleanFileName, contentDisposition } from '../src/routes/site-documents.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = [
  'documents.view',
  'documents.create',
  'documents.update',
  'documents.delete',
  'sites.delete',
]

const PDF = Buffer.from('%PDF-1.4\n% prova\n%%EOF\n')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(permissions)
  const user = await fx.user({ name: 'Mario Bianchi' })
  const role = await fx.role(company.id, 'Documenti', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const sites = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta'), ($1, 'Condominio')
     returning id`,
    [company.id],
  )
  const site = sites.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/sites/${site}/documents`
  const upload = (
    body: Buffer,
    type: string,
    query = 'file_name=verbale.pdf',
    b: Browser = browser,
    url = base,
  ) => b.call('POST', `${url}?${query}`, { body, headers: { 'content-type': type } })
  return {
    browser,
    company,
    user,
    site,
    other: sites.rows[1]?.id ?? '',
    base,
    upload,
  }
}

interface Doc {
  id: string
  kind: string
  title: string
  file_name: string
  size: number
  notes: string | null
  uploaded_by: { id: string; name: string } | null
}

describe('site documents and photos', () => {
  it('uploads, lists, downloads, renames and deletes', async () => {
    const s = await scene()
    const created = await s.upload(PDF, 'application/pdf', 'file_name=Verbale%20consegna.pdf')
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    const doc = created.json<Doc>()
    expect(doc).toMatchObject({
      kind: 'document',
      title: 'Verbale consegna.pdf',
      file_name: 'Verbale consegna.pdf',
      size: PDF.length,
      notes: null,
      uploaded_by: { id: s.user.id, name: 'Mario Bianchi' },
    })
    const photo = await s.upload(JPEG, 'image/jpeg', 'file_name=IMG_001.jpg&title=Getto%20solaio')
    expect(photo.statusCode).toBe(201)
    expect(photo.json<Doc>()).toMatchObject({ kind: 'photo', title: 'Getto solaio' })
    expect((await s.upload(DOCX, DOCX_TYPE, 'file_name=pos.docx')).statusCode).toBe(201)

    const all = await s.browser.call('GET', s.base)
    expect(all.statusCode).toBe(200)
    expect(all.json<{ meta: { total: number } }>().meta.total).toBe(3)
    const photos = await s.browser.call('GET', `${s.base}?filter[kind]=photo`)
    expect(photos.json<{ data: Doc[] }>().data.map((d) => d.title)).toEqual(['Getto solaio'])
    expect((await s.browser.call('GET', `${s.base}?filter[kind]=video`)).statusCode).toBe(422)
    const paged = await s.browser.call('GET', `${s.base}?per_page=2&page=2`)
    expect(paged.json<{ data: Doc[] }>().data.map((d) => d.title)).toEqual(['Verbale consegna.pdf'])

    const content = await s.browser.call('GET', `${s.base}/${doc.id}/content`)
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.equals(PDF)).toBe(true)
    expect(content.headers['content-type']).toBe('application/pdf')
    expect(content.headers['content-disposition']).toBe(
      `attachment; filename="Verbale consegna.pdf"; filename*=UTF-8''Verbale%20consegna.pdf`,
    )
    expect(content.headers['x-content-type-options']).toBe('nosniff')

    const one = await s.browser.call('GET', `${s.base}/${doc.id}`)
    expect(one.statusCode).toBe(200)
    expect(
      (
        await s.browser.call('PUT', `${s.base}/${doc.id}`, {
          body: { title: 'Verbale', notes: null },
        })
      ).statusCode,
    ).toBe(428)
    const renamed = await s.browser.call('PUT', `${s.base}/${doc.id}`, {
      body: { title: '  Verbale di consegna  ', notes: 'Firmato' },
      headers: { 'if-match': '"1"' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.headers.etag).toBe('"2"')
    expect(renamed.json<Doc>()).toMatchObject({ title: 'Verbale di consegna', notes: 'Firmato' })
    expect(
      (
        await s.browser.call('PUT', `${s.base}/${doc.id}`, {
          body: { title: '', notes: null },
          headers: { 'if-match': '"2"' },
        })
      ).statusCode,
    ).toBe(422)
    expect(
      (
        await s.browser.call('DELETE', `${s.base}/${doc.id}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(412)
    expect(
      (
        await s.browser.call('DELETE', `${s.base}/${doc.id}`, {
          headers: { 'if-match': '"2"' },
        })
      ).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', `${s.base}/${doc.id}`)).statusCode).toBe(404)
    expect((await s.browser.call('GET', `${s.base}/${doc.id}/content`)).statusCode).toBe(404)
    const files = await ctx.owner.query(
      'select 1 from public.site_document_files where document_id = $1',
      [doc.id],
    )
    expect(files.rowCount).toBe(0)
  })

  it.each([
    ['a PNG declared as PDF', PNG, 'application/pdf', 'file_name=a.pdf', 422],
    ['text declared as JPEG', Buffer.from('ciao'), 'image/jpeg', 'file_name=a.jpg', 422],
    ['an empty file', Buffer.alloc(0), 'application/pdf', 'file_name=a.pdf', 422],
    ['no file name', PDF, 'application/pdf', 'title=x', 422],
    ['a file name that is only a path', PDF, 'application/pdf', 'file_name=..%2F', 422],
    ['an unknown type', Buffer.from('x'), 'application/octet-stream', 'file_name=a.bin', 415],
    ['an SVG', Buffer.from('<svg/>'), 'image/svg+xml', 'file_name=a.svg', 415],
    [
      'a file over 20 MB',
      Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]),
      'application/pdf',
      'file_name=a.pdf',
      413,
    ],
  ])('refuses %s', async (_label, body, type, query, status) => {
    const s = await scene()
    expect((await s.upload(body, type, query)).statusCode).toBe(status)
  })

  it('searches the title, the file name and the notes', async () => {
    const s = await scene()
    const other = await scene()
    expect((await other.upload(PDF, 'application/pdf', 'file_name=Verbale.pdf')).statusCode).toBe(
      201,
    )
    const verbale = await s.upload(PDF, 'application/pdf', 'file_name=verbale_consegna.pdf')
    const photo = await s.upload(JPEG, 'image/jpeg', 'file_name=IMG_001.jpg&title=Getto%20solaio')
    const pos = await s.upload(DOCX, DOCX_TYPE, 'file_name=pos.docx&title=Piano%20sicurezza')
    await ctx.owner.query(
      "update public.site_documents set notes = 'Firmato dal coordinatore' where id = $1",
      [pos.json<Doc>().id],
    )
    // A document of the other site of the same company is never in this list.
    await s.upload(
      PDF,
      'application/pdf',
      'file_name=verbale.pdf',
      s.browser,
      s.base.replace(s.site, s.other),
    )
    const titles = async (query: string) => {
      const res = await s.browser.call('GET', `${s.base}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<{ data: Doc[]; meta: { total: number } }>()
    }
    expect((await titles('filter[q]=%20VERBALE%20')).data.map((d) => d.id)).toEqual([
      verbale.json<Doc>().id,
    ])
    expect((await titles('filter[q]=img_001')).data.map((d) => d.id)).toEqual([
      photo.json<Doc>().id,
    ])
    expect((await titles('filter[q]=solaio&filter[kind]=photo')).meta.total).toBe(1)
    expect((await titles('filter[q]=solaio&filter[kind]=document')).meta.total).toBe(0)
    expect((await titles('filter[q]=coordinatore')).data.map((d) => d.id)).toEqual([
      pos.json<Doc>().id,
    ])
    expect((await titles('filter[q]=%25')).meta.total).toBe(0)
    expect((await titles('filter[q]=img_')).meta.total).toBe(1)
    expect((await titles('filter[q]=img%5F0%5F')).meta.total).toBe(0)
    expect((await titles('filter[q]=%20%20')).meta.total).toBe(3)
    for (const query of [`filter[q]=${'a'.repeat(101)}`, 'filter[q]=a&filter[q]=b']) {
      const res = await s.browser.call('GET', `${s.base}?${query}`)
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty(['filter[q]'])
    }
  })

  it('refuses an upload without session or CSRF token before reading the body', async () => {
    const s = await scene()
    const big = Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)])
    const stranger = new Browser(ctx.app)
    const anonymous = await stranger.call('POST', `${s.base}?file_name=a.pdf`, {
      body: big,
      headers: { 'content-type': 'application/pdf' },
    })
    expect(anonymous.statusCode).toBe(401)
    const raw = await ctx.app.inject({
      method: 'POST',
      url: `${s.base}?file_name=a.pdf`,
      payload: PDF,
      headers: {
        'content-type': 'application/pdf',
        cookie: [...s.browser.cookies]
          .filter(([k]) => k !== 'XSRF-TOKEN')
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
    })
    expect(raw.statusCode).toBe(403)
    expect(raw.json<{ code: string }>().code).toBe('csrf_invalid')
  })

  it('keeps only the last part of the file name', () => {
    expect(cleanFileName('C:\\Users\\a\\foto.jpg')).toBe('foto.jpg')
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('a"b\u0000.pdf')).toBe('ab.pdf')
    expect(cleanFileName('..')).toBeNull()
    expect(contentDisposition('perizia è "ok".pdf')).toBe(
      `attachment; filename="perizia _ _ok_.pdf"; filename*=UTF-8''perizia%20%C3%A8%20%22ok%22.pdf`,
    )
  })

  it('answers 404 for a site of another company or a document of another site', async () => {
    const s = await scene()
    const doc = (await s.upload(PDF, 'application/pdf')).json<Doc>()
    const elsewhere = `/api/companies/${s.company.slug}/sites/${s.other}/documents`
    expect((await s.browser.call('GET', `${elsewhere}/${doc.id}`)).statusCode).toBe(404)
    expect((await s.browser.call('GET', `${elsewhere}/${doc.id}/content`)).statusCode).toBe(404)
    expect(
      (
        await s.browser.call('DELETE', `${elsewhere}/${doc.id}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
    const missing = `/api/companies/${s.company.slug}/sites/00000000-0000-4000-8000-000000000000/documents`
    expect((await s.browser.call('GET', missing)).statusCode).toBe(404)
    expect(
      (await s.upload(PDF, 'application/pdf', 'file_name=a.pdf', s.browser, missing)).statusCode,
    ).toBe(404)

    const other = await scene()
    expect((await other.browser.call('GET', s.base)).statusCode).toBe(404)
    expect((await other.browser.call('GET', `${s.base}/${doc.id}/content`)).statusCode).toBe(404)
    expect(
      (await other.upload(PDF, 'application/pdf', 'file_name=a.pdf', other.browser, s.base))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await other.browser.call('DELETE', `${s.base}/${doc.id}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
  })

  it('checks the permissions', async () => {
    const owner = await scene()
    const doc = (await owner.upload(PDF, 'application/pdf')).json<Doc>()
    const viewer = await fx.user()
    const role = await fx.role(owner.company.id, 'Solo vista', ['documents.view'])
    await fx.member(viewer.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(viewer.email)
    expect((await browser.call('GET', owner.base)).statusCode).toBe(200)
    expect(
      (await owner.upload(PDF, 'application/pdf', 'file_name=a.pdf', browser)).statusCode,
    ).toBe(403)
    expect(
      (
        await browser.call('PUT', `${owner.base}/${doc.id}`, {
          body: { title: 'x', notes: null },
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await browser.call('DELETE', `${owner.base}/${doc.id}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(403)
    const none = await fx.user()
    await fx.member(none.id, owner.company.id, await fx.role(owner.company.id, 'Nessuno', []))
    const blind = new Browser(ctx.app)
    await blind.signIn(none.email)
    expect((await blind.call('GET', owner.base)).statusCode).toBe(404)
    expect((await blind.call('GET', `${owner.base}/${doc.id}/content`)).statusCode).toBe(404)
  })

  it('keeps a site with documents from being deleted', async () => {
    const s = await scene()
    await s.upload(JPEG, 'image/jpeg', 'file_name=a.jpg')
    const site = await s.browser.call(
      'DELETE',
      `/api/companies/${s.company.slug}/sites/${s.site}`,
      {
        headers: { 'if-match': '"1"' },
      },
    )
    expect(site.statusCode).toBe(409)
    expect(site.json<{ code: string }>().code).toBe('has_documents')
  })

  it('writes the audit log without the file', async () => {
    const s = await scene()
    const doc = (await s.upload(PDF, 'application/pdf')).json<Doc>()
    const { rows } = await ctx.owner.query<{ action: string; user_id: string }>(
      "select action, user_id from public.audit_log where entity = 'site_document' and entity_id = $1",
      [doc.id],
    )
    expect(rows).toEqual([{ action: 'create', user_id: s.user.id }])
  })
  it('links photos to a daily report of the same site and lists them', async () => {
    const s = await scene()
    const reports = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date)
       values ($1, $2, '2026-11-06'), ($1, $3, '2026-11-06') returning id`,
      [s.company.id, s.site, s.other],
    )
    const mine = reports.rows[0]?.id ?? ''
    const elsewhere = reports.rows[1]?.id ?? ''
    const linked = await s.upload(JPEG, 'image/jpeg', `file_name=scavo.jpg&daily_report_id=${mine}`)
    expect(linked.statusCode).toBe(201)
    expect(linked.json()).toMatchObject({ kind: 'photo', daily_report_id: mine })
    const loose = await s.upload(JPEG, 'image/jpeg', 'file_name=altro.jpg')
    expect(loose.json()).toMatchObject({ daily_report_id: null })

    const listed = await s.browser.call('GET', `${s.base}?filter[daily_report]=${mine}`)
    expect(listed.statusCode).toBe(200)
    expect(listed.json<{ data: Doc[] }>().data.map((d) => d.id)).toEqual([linked.json<Doc>().id])
    expect((await s.browser.call('GET', `${s.base}?filter[daily_report]=abc`)).statusCode).toBe(422)

    for (const report of [elsewhere, '00000000-0000-4000-8000-000000000000', 'abc']) {
      const res = await s.upload(JPEG, 'image/jpeg', `file_name=x.jpg&daily_report_id=${report}`)
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ errors: { daily_report_id: [expect.any(String)] } })
    }

    // A draft report moved to another site takes its photos along.
    await ctx.owner.query('delete from public.daily_reports where id = $1', [elsewhere])
    await ctx.owner.query('update public.daily_reports set site_id = $1 where id = $2', [
      s.other,
      mine,
    ])
    const moved = await ctx.owner.query<{ site_id: string }>(
      'select site_id from public.site_documents where id = $1',
      [linked.json<Doc>().id],
    )
    expect(moved.rows[0]?.site_id).toBe(s.other)

    // Deleting the report keeps the photo in the site archive.
    await ctx.owner.query('delete from public.daily_reports where id = $1', [mine])
    const kept = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/sites/${s.other}/documents/${linked.json<Doc>().id}`,
    )
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toMatchObject({ daily_report_id: null })
  })
})
