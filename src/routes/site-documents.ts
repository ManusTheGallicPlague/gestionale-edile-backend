import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  DOCX,
  XLSX,
] as const
type DocumentType = (typeof DOCUMENT_TYPES)[number]
const KINDS = ['document', 'photo'] as const
type Kind = (typeof KINDS)[number]

/** True when the first bytes of the file match the declared type. */
export function matchesType(data: Buffer, type: DocumentType): boolean {
  const starts = (bytes: number[], offset = 0) =>
    data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b)
  switch (type) {
    case 'application/pdf':
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff])
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/webp':
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
    case DOCX:
    case XLSX:
      return starts([0x50, 0x4b, 0x03, 0x04]) // a ZIP archive
  }
}

/** The last path component, without control characters; null if nothing is left. */
export function cleanFileName(value: string): string | null {
  const base = value.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim()
  return clean === '' || clean === '.' || clean === '..' ? null : clean
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

interface DocumentRow {
  id: string
  site_id: string
  daily_report_id: string | null
  kind: Kind
  title: string
  file_name: string
  content_type: string
  size_bytes: number
  notes: string | null
  uploaded_by: string | null
  uploaded_by_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

const SELECT = `select d.id, d.site_id, d.daily_report_id, d.kind, d.title, d.file_name, d.content_type,
    d.size_bytes, d.notes, d.uploaded_by, u.name as uploaded_by_name, d.version,
    d.created_at, d.updated_at
  from public.site_documents d
  left join lateral app.audit_users(array[d.uploaded_by]) u on true`

function toContract(row: DocumentRow) {
  return {
    id: row.id,
    site_id: row.site_id,
    daily_report_id: row.daily_report_id,
    kind: row.kind,
    title: row.title,
    file_name: row.file_name,
    content_type: row.content_type,
    size: row.size_bytes,
    notes: row.notes,
    uploaded_by: row.uploaded_by ? { id: row.uploaded_by, name: row.uploaded_by_name ?? '' } : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.documentMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

type Params = { company: string; site: string; document?: string }

function single(query: Record<string, unknown>, name: string, errors: FieldErrors) {
  const value = query[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    errors[name] = ['Indicalo una volta sola.']
    return undefined
  }
  return value
}

function readList(query: Record<string, unknown>) {
  const errors: FieldErrors = {}
  const integer = (name: string, fallback: number, max?: number): number => {
    const value = single(query, name, errors)
    if (value === undefined) return fallback
    const n = /^\d{1,6}$/.test(value) ? Number(value) : NaN
    if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
      errors[name] = [max ? `Un numero intero da 1 a ${max}.` : 'Un numero intero da 1 in su.']
      return fallback
    }
    return n
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const kindValue = single(query, 'filter[kind]', errors)
  const kind = KINDS.find((k) => k === kindValue)
  if (kindValue !== undefined && !kind) errors['filter[kind]'] = ['Tipo non valido.']
  const report = single(query, 'filter[daily_report]', errors)
  if (report !== undefined && !UUID.test(report)) {
    errors['filter[daily_report]'] = ['Rapportino non valido.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, kind, report }
}

function readUpload(query: Record<string, unknown>) {
  const errors: FieldErrors = {}
  const fileValue = single(query, 'file_name', errors)
  const titleValue = single(query, 'title', errors)
  const reportValue = single(query, 'daily_report_id', errors)
  const daily_report_id = reportValue === undefined ? null : reportValue.trim()
  if (daily_report_id !== null && !UUID.test(daily_report_id)) {
    errors.daily_report_id = ['Rapportino non trovato in questo cantiere.']
  }
  let file_name: string | null = null
  if (fileValue === undefined) {
    errors.file_name ??= ['Indica il nome del file.']
  } else {
    file_name = cleanFileName(fileValue)
    if (!file_name) errors.file_name = ['Nome del file non valido.']
    else if (file_name.length > 200) errors.file_name = ['Al massimo 200 caratteri.']
  }
  let title: string | null = null
  if (titleValue !== undefined) {
    title = titleValue.trim() === '' ? null : titleValue.trim()
    if (title && title.length > 200) errors.title = ['Al massimo 200 caratteri.']
  }
  if (Object.keys(errors).length > 0 || !file_name) throw new ValidationFailed(errors)
  return { file_name, title: title ?? file_name, daily_report_id }
}

function parseUpdate(body: unknown) {
  const errors: FieldErrors = {}
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number): string | null => {
    if (!(field in raw)) {
      errors[field] = ['Campo mancante.']
      return null
    }
    const value = raw[field]
    if (value === null) return null
    if (typeof value !== 'string') {
      errors[field] = ['Deve essere un testo.']
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) errors[field] = [`Al massimo ${max} caratteri.`]
    return trimmed === '' ? null : trimmed
  }
  const title = text('title', 200)
  if (title === null && !errors.title) errors.title = ['Indica il titolo.']
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !title) throw new ValidationFailed(errors)
  return { title, notes }
}

async function siteExists(client: PoolClient, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false
  const { rowCount } = await client.query('select 1 from public.sites where id = $1', [id])
  return Boolean(rowCount)
}

async function readOne(client: PoolClient, siteId: string, id: string) {
  if (!UUID.test(siteId) || !UUID.test(id)) return undefined
  const { rows } = await client.query<DocumentRow>(`${SELECT} where d.id = $1 and d.site_id = $2`, [
    id,
    siteId,
  ])
  return rows[0]
}

/**
 * Documents and photos of a site: the file is the body of the upload, with its own
 * Content-Type; name and title travel in the query string.
 */
export function siteDocumentRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/sites/:site/documents'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('documents.view')) throw notFound()
      if (!(await siteExists(client, request.params.site))) throw notFound()
      const values: unknown[] = [request.params.site]
      let where = 'd.site_id = $1'
      if (list.kind) {
        values.push(list.kind)
        where += ` and d.kind = $${values.length}`
      }
      if (list.report) {
        values.push(list.report)
        where += ` and d.daily_report_id = $${values.length}`
      }
      const filters = values.length
      const { rows } = await client.query<DocumentRow>(
        `${SELECT} where ${where} order by d.created_at desc, d.id desc
         limit $${filters + 1} offset $${filters + 2}`,
        [...values, list.perPage, (list.page - 1) * list.perPage],
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.site_documents d where ${where}`,
        values,
      )
      return {
        data: rows.map(toContract),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
      }
    })
  })

  app.get<{ Params: Params }>(`${base}/:document`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('documents.view')) throw notFound()
      return readOne(client, request.params.site, request.params.document ?? '')
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.get<{ Params: Params }>(`${base}/:document/content`, async (request, reply) => {
    const session = requireSession(request)
    const file = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('documents.view')) throw notFound()
      const row = await readOne(client, request.params.site, request.params.document ?? '')
      if (!row) throw notFound()
      const { rows } = await client.query<{ data: Buffer }>(
        'select data from public.site_document_files where document_id = $1',
        [row.id],
      )
      if (!rows[0]) throw notFound()
      return { row, data: rows[0].data }
    })
    return reply
      .header('Content-Type', file.row.content_type)
      .header('Content-Disposition', contentDisposition(file.row.file_name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-cache')
      .header('ETag', `"${file.row.version}"`)
      .send(file.data)
  })

  app.put<{ Params: Params }>(`${base}/:document`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('documents.update')) throw forbidden()
      const current = await readOne(client, request.params.site, request.params.document ?? '')
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseUpdate(request.body)
      const { rowCount } = await client.query(
        `update public.site_documents set title = $1, notes = $2, version = version + 1,
           updated_at = now()
         where id = $3 and version = $4`,
        [input.title, input.notes, current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.documentStale, 'stale_record')
      return readOne(client, request.params.site, current.id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.delete<{ Params: Params }>(`${base}/:document`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('documents.delete')) throw forbidden()
      const current = await readOne(client, request.params.site, request.params.document ?? '')
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.site_documents where id = $1 and version = $2',
        [current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.documentStale, 'stale_record')
    })
    return reply.code(204).send()
  })

  app.register((scope, _options, done) => {
    // Refuse a stranger before reading up to 20 MB of body.
    scope.addHook('preParsing', (request, _reply, payload, done) => {
      try {
        requireSession(request)
        checkCsrf(config, request)
      } catch (error) {
        done(error as Error)
        return
      }
      done(null, payload)
    })
    scope.addContentTypeParser(
      [...DOCUMENT_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES },
      (_request, body, done) => {
        done(null, body)
      },
    )

    scope.post<{ Params: Params; Querystring: Record<string, unknown> }>(
      base,
      async (request, reply) => {
        const session = requireSession(request)
        checkCsrf(config, request)
        const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has('documents.create')) throw forbidden()
          if (!(await siteExists(client, request.params.site))) throw notFound()
          const input = readUpload(request.query)
          const body = request.body
          const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim()
          const type = DOCUMENT_TYPES.find((t) => t === declared)
          if (!Buffer.isBuffer(body) || body.length === 0 || !type || !matchesType(body, type)) {
            throw new ValidationFailed({
              file: ['Il file non corrisponde al suo tipo, oppure è vuoto.'],
            })
          }
          if (input.daily_report_id !== null) {
            const report = await client.query(
              'select 1 from public.daily_reports where id = $1 and site_id = $2',
              [input.daily_report_id, request.params.site],
            )
            if (!report.rowCount) {
              throw new ValidationFailed({
                daily_report_id: ['Rapportino non trovato in questo cantiere.'],
              })
            }
          }
          const kind: Kind = type.startsWith('image/') ? 'photo' : 'document'
          const { rows } = await client.query<{ id: string }>(
            `insert into public.site_documents (company_id, site_id, daily_report_id, kind, title,
               file_name, content_type, size_bytes, uploaded_by)
             values (app.current_company_id(), $1, $8, $2, $3, $4, $5, $6, $7) returning id`,
            [
              request.params.site,
              kind,
              input.title,
              input.file_name,
              type,
              body.length,
              session.user.id,
              input.daily_report_id,
            ],
          )
          const id = rows[0]?.id ?? ''
          await client.query(
            `insert into public.site_document_files (document_id, company_id, data)
             values ($1, app.current_company_id(), $2)`,
            [id, body],
          )
          return readOne(client, request.params.site, id)
        })
        if (!row) throw new Error('insert returned no row')
        return reply.code(201).header('ETag', `"${row.version}"`).send(toContract(row))
      },
    )
    done()
  })
}
