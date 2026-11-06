import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { DOCUMENT_FIELDS, parseDocumentInput, type DocumentInput } from '../suppliers/documents.js'
import { ApiError, ValidationFailed, forbidden, messages, notFound } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'

interface DocumentRow extends DocumentInput {
  id: string
  supplier_id: string
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry'
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
  end as status`

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

const KIND_LABEL = {
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
}
