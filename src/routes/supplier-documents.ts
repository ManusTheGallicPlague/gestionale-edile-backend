import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { DOCUMENT_FIELDS, parseDocumentInput, type DocumentInput } from '../suppliers/documents.js'
import { ApiError, ValidationFailed, forbidden, messages, notFound } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import {
  ATTACHMENT_JSON,
  ATTACHMENT_TYPES,
  sendAttachment,
  uploadScope,
  type AttachmentInfo,
} from '../http/files.js'
import { cleanFileName, matchesType } from './site-documents.js'

interface DocumentRow extends DocumentInput {
  id: string
  supplier_id: string
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry'
  file: AttachmentInfo | null
  version: number
  created_at: Date
  updated_at: Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Dates leave the database as text: a JavaScript Date would shift them with the time zone.
// "Today" is the Italian one, not the server's.
const COLUMNS = `id, supplier_id, kind, description, issued_on::text as issued_on,
  expires_on::text as expires_on, notes, version, created_at, updated_at,
  case
    when expires_on is null then 'no_expiry'
    when expires_on < (now() at time zone 'Europe/Rome')::date then 'expired'
    when expires_on <= (now() at time zone 'Europe/Rome')::date + 30 then 'expiring'
    else 'valid'
  end as status,
  (select ${ATTACHMENT_JSON}
   from public.supplier_document_files f
   where f.document_id = supplier_documents.id) as file`

type Params = { company: string; supplier?: string; document?: string }

function toContract(row: DocumentRow) {
  return {
    id: row.id,
    supplier_id: row.supplier_id,
    kind: row.kind,
    description: row.description,
    issued_on: row.issued_on,
    expires_on: row.expires_on,
    notes: row.notes,
    status: row.status,
    file: row.file,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: DocumentRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.documentMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

/** The supplier in the path, if this company can see it; 404 otherwise. */
async function visibleSupplier(client: PoolClient, id: string | undefined): Promise<string> {
  if (!id || !UUID.test(id)) throw notFound()
  const { rowCount } = await client.query('select 1 from public.suppliers where id = $1', [id])
  if (!rowCount) throw notFound()
  return id
}

async function missingOrStale(client: PoolClient, id: string, supplierId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.supplier_documents where id = $1 and supplier_id = $2',
    [id, supplierId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.documentStale, 'stale_record')
}

export const KIND_LABEL = {
  durc: 'DURC',
  chamber_extract: 'Visura camerale',
  insurance: 'Assicurazione',
  other: 'Documento',
} as const

/**
 * Keeps the document's deadline in step: one open deadline on the expiry date, linked to the
 * supplier; none when the document does not expire. A new expiry date (a renewal) reopens it.
 */
async function syncDeadline(client: PoolClient, documentId: string): Promise<void> {
  await client.query(
    `delete from public.deadlines d using public.supplier_documents sd
     where d.supplier_document_id = sd.id and sd.id = $1 and sd.expires_on is null`,
    [documentId],
  )
  await client.query(
    `insert into public.deadlines (company_id, title, due_on, kind, supplier_id, supplier_document_id)
     select sd.company_id,
       left(coalesce(sd.description, case sd.kind
         when 'durc' then $2 when 'chamber_extract' then $3 when 'insurance' then $4 else $5 end)
         || ' – ' || s.name, 200),
       sd.expires_on,
       case when sd.kind in ('durc', 'insurance') then sd.kind else 'other' end,
       sd.supplier_id, sd.id
     from public.supplier_documents sd
     join public.suppliers s on s.id = sd.supplier_id
     where sd.id = $1 and sd.expires_on is not null
     on conflict (supplier_document_id) do update set
       title = excluded.title, kind = excluded.kind,
       status = case when deadlines.due_on = excluded.due_on then deadlines.status else 'open' end,
       done_at = case when deadlines.due_on = excluded.due_on then deadlines.done_at end,
       due_on = excluded.due_on,
       version = deadlines.version + 1, updated_at = now()`,
    [
      documentId,
      KIND_LABEL.durc,
      KIND_LABEL.chamber_extract,
      KIND_LABEL.insurance,
      KIND_LABEL.other,
    ],
  )
}

export function supplierDocumentRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/suppliers/:supplier/documents'

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.view')) throw notFound()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const { rows } = await client.query<DocumentRow>(
        `select ${COLUMNS} from public.supplier_documents
         where supplier_id = $1
         order by expires_on asc nulls last, created_at asc, id asc`,
        [supplierId],
      )
      return { data: rows.map(toContract) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.update')) throw forbidden()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const parsed = parseDocumentInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values = [supplierId, ...DOCUMENT_FIELDS.map((f) => parsed.input[f])]
      const { rows } = await client.query<DocumentRow>(
        `insert into public.supplier_documents (company_id, supplier_id, ${DOCUMENT_FIELDS.join(', ')})
         values (app.current_company_id(), $1, ${DOCUMENT_FIELDS.map((_, i) => `$${i + 2}`).join(', ')})
         returning ${COLUMNS}`,
        values,
      )
      if (rows[0]) await syncDeadline(client, rows[0].id)
      return rows[0]
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:document`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.update')) throw forbidden()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseDocumentInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = DOCUMENT_FIELDS.map((f) => parsed.input[f])
      values.push(id, supplierId, version)
      const n = values.length
      const { rows } = await client.query<DocumentRow>(
        `update public.supplier_documents
         set ${DOCUMENT_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $${n - 2} and supplier_id = $${n - 1} and version = $${n}
         returning ${COLUMNS}`,
        values,
      )
      if (!rows[0]) return missingOrStale(client, id, supplierId)
      await syncDeadline(client, id)
      return rows[0]
    })
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:document`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.update')) throw forbidden()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.supplier_documents where id = $1 and supplier_id = $2 and version = $3',
        [id, supplierId, version],
      )
      if (!rowCount) await missingOrStale(client, id, supplierId)
    })
    return reply.code(204).send()
  })

  const readOne = async (client: PoolClient, id: string) => {
    const { rows } = await client.query<DocumentRow>(
      `select ${COLUMNS} from public.supplier_documents where id = $1`,
      [id],
    )
    if (!rows[0]) throw new Error('document vanished inside its transaction')
    return rows[0]
  }

  /** Takes the next version of the document, or answers 404/412 as the other writes do. */
  const bumpVersion = async (
    client: PoolClient,
    id: string,
    supplierId: string,
    version: number,
  ): Promise<void> => {
    const { rowCount } = await client.query(
      `update public.supplier_documents set version = version + 1, updated_at = now()
       where id = $1 and supplier_id = $2 and version = $3`,
      [id, supplierId, version],
    )
    if (!rowCount) await missingOrStale(client, id, supplierId)
  }

  app.get<{ Params: Params }>(`${base}/:document/file`, async (request, reply) => {
    const session = requireSession(request)
    const file = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.view')) throw notFound()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<{
        file_name: string
        content_type: string
        data: Buffer
        version: number
      }>(
        `select f.file_name, f.content_type, f.data, d.version
         from public.supplier_document_files f
         join public.supplier_documents d on d.id = f.document_id
         where d.id = $1 and d.supplier_id = $2`,
        [id, supplierId],
      )
      if (!rows[0]) throw notFound()
      return rows[0]
    })
    return sendAttachment(reply, file)
  })

  app.delete<{ Params: Params }>(`${base}/:document/file`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.update')) throw forbidden()
      const supplierId = await visibleSupplier(client, request.params.supplier)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      await bumpVersion(client, id, supplierId, version)
      const { rowCount } = await client.query(
        'delete from public.supplier_document_files where document_id = $1',
        [id],
      )
      // No file: the error rolls the version back.
      if (!rowCount) throw notFound()
      return readOne(client, id)
    })
    return send(reply, row)
  })

  uploadScope(app, config, (scope) => {
    scope.put<{ Params: Params; Querystring: Record<string, unknown> }>(
      `${base}/:document/file`,
      async (request, reply) => {
        const session = requireSession(request)
        checkCsrf(config, request)
        const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has('suppliers.update')) throw forbidden()
          const supplierId = await visibleSupplier(client, request.params.supplier)
          const id = request.params.document ?? ''
          if (!UUID.test(id)) throw notFound()
          const version = expectedVersion(request.headers['if-match'])
          const rawName = request.query.file_name
          const fileName = typeof rawName === 'string' ? cleanFileName(rawName) : null
          if (fileName === null || fileName.length > 200) {
            throw new ValidationFailed({
              file_name: [
                fileName === null ? 'Indica il nome del file.' : 'Al massimo 200 caratteri.',
              ],
            })
          }
          const body = request.body
          const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim()
          const type = ATTACHMENT_TYPES.find((t) => t === declared)
          if (!Buffer.isBuffer(body) || body.length === 0 || !type || !matchesType(body, type)) {
            throw new ValidationFailed({
              file: ['Il file non corrisponde al suo tipo, oppure è vuoto.'],
            })
          }
          await bumpVersion(client, id, supplierId, version)
          await client.query('delete from public.supplier_document_files where document_id = $1', [
            id,
          ])
          await client.query(
            `insert into public.supplier_document_files
               (document_id, company_id, file_name, content_type, size_bytes, data)
             values ($1, app.current_company_id(), $2, $3, $4, $5)`,
            [id, fileName, type, body.length, body],
          )
          return readOne(client, id)
        })
        return send(reply, row)
      },
    )
  })
}
