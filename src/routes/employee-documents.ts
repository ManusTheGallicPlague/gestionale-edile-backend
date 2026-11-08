import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
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

export const EMPLOYEE_DOCUMENT_KINDS = [
  'medical_check',
  'safety_training',
  'first_aid',
  'fire_safety',
  'license',
  'other',
] as const
export type EmployeeDocumentKind = (typeof EMPLOYEE_DOCUMENT_KINDS)[number]

/** Names of the kinds in the titles of the deadlines. */
export const KIND_LABEL: Record<EmployeeDocumentKind, string> = {
  medical_check: 'Idoneità sanitaria',
  safety_training: 'Formazione sicurezza',
  first_aid: 'Primo soccorso',
  fire_safety: 'Antincendio',
  license: 'Patentino',
  other: 'Documento',
}

interface DocumentRow extends DocumentInput<EmployeeDocumentKind> {
  id: string
  employee_id: string
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry'
  file: AttachmentInfo | null
  version: number
  created_at: Date
  updated_at: Date
}

// Dates leave the database as text: a JavaScript Date would shift them with the time zone.
// "Today" is the Italian one, not the server's.
const COLUMNS = `id, employee_id, kind, description, issued_on::text as issued_on,
  expires_on::text as expires_on, notes, version, created_at, updated_at,
  case
    when expires_on is null then 'no_expiry'
    when expires_on < (now() at time zone 'Europe/Rome')::date then 'expired'
    when expires_on <= (now() at time zone 'Europe/Rome')::date + 30 then 'expiring'
    else 'valid'
  end as status,
  (select ${ATTACHMENT_JSON}
   from public.employee_document_files f
   where f.document_id = employee_documents.id) as file`

type Params = { company: string; employee?: string; document?: string }

function toContract(row: DocumentRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
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

/** The employee in the path, if this company can see it; 404 otherwise. */
async function visibleEmployee(client: PoolClient, id: string | undefined): Promise<string> {
  if (!id || !UUID.test(id)) throw notFound()
  const { rowCount } = await client.query('select 1 from public.employees where id = $1', [id])
  if (!rowCount) throw notFound()
  return id
}

async function missingOrStale(client: PoolClient, id: string, employeeId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.employee_documents where id = $1 and employee_id = $2',
    [id, employeeId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.documentStale, 'stale_record')
}

/**
 * Keeps the document's deadline in step: one deadline of the employee on the expiry date; none
 * when the document does not expire. A new expiry date (a renewal) reopens it.
 */
async function syncDeadline(client: PoolClient, documentId: string): Promise<void> {
  await client.query(
    `delete from public.deadlines d using public.employee_documents ed
     where d.employee_document_id = ed.id and ed.id = $1 and ed.expires_on is null`,
    [documentId],
  )
  await client.query(
    `insert into public.deadlines (company_id, title, due_on, kind, employee_id,
       employee_document_id)
     select ed.company_id,
       left(coalesce(ed.description, case ed.kind
         when 'medical_check' then $2 when 'safety_training' then $3 when 'first_aid' then $4
         when 'fire_safety' then $5 when 'license' then $6 else $7 end)
         || ' – ' || e.last_name || ' ' || e.first_name, 200),
       ed.expires_on,
       case ed.kind when 'medical_check' then 'medical_check' when 'other' then 'other'
         else 'training' end,
       ed.employee_id, ed.id
     from public.employee_documents ed
     join public.employees e on e.id = ed.employee_id
     where ed.id = $1 and ed.expires_on is not null
     on conflict (employee_document_id) do update set
       title = excluded.title,
       kind = excluded.kind,
       status = case when deadlines.due_on = excluded.due_on then deadlines.status else 'open' end,
       done_at = case when deadlines.due_on = excluded.due_on then deadlines.done_at end,
       due_on = excluded.due_on,
       version = deadlines.version + 1, updated_at = now()
     where deadlines.title is distinct from excluded.title
        or deadlines.kind is distinct from excluded.kind
        or deadlines.due_on is distinct from excluded.due_on`,
    [
      documentId,
      KIND_LABEL.medical_check,
      KIND_LABEL.safety_training,
      KIND_LABEL.first_aid,
      KIND_LABEL.fire_safety,
      KIND_LABEL.license,
      KIND_LABEL.other,
    ],
  )
}

const parse = (body: unknown) => parseDocumentInput(body, EMPLOYEE_DOCUMENT_KINDS)

export function employeeDocumentRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/employees/:employee/documents'

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const { rows } = await client.query<DocumentRow>(
        `select ${COLUMNS} from public.employee_documents
         where employee_id = $1
         order by expires_on asc nulls last, created_at asc, id asc`,
        [employeeId],
      )
      return { data: rows.map(toContract) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const parsed = parse(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values = [employeeId, ...DOCUMENT_FIELDS.map((f) => parsed.input[f])]
      const { rows } = await client.query<DocumentRow>(
        `insert into public.employee_documents (company_id, employee_id, ${DOCUMENT_FIELDS.join(', ')})
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
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parse(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = DOCUMENT_FIELDS.map((f) => parsed.input[f])
      values.push(id, employeeId, version)
      const n = values.length
      const { rows } = await client.query<DocumentRow>(
        `update public.employee_documents
         set ${DOCUMENT_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $${n - 2} and employee_id = $${n - 1} and version = $${n}
         returning ${COLUMNS}`,
        values,
      )
      if (!rows[0]) return missingOrStale(client, id, employeeId)
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
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.employee_documents where id = $1 and employee_id = $2 and version = $3',
        [id, employeeId, version],
      )
      if (!rowCount) await missingOrStale(client, id, employeeId)
    })
    return reply.code(204).send()
  })

  const readOne = async (client: PoolClient, id: string) => {
    const { rows } = await client.query<DocumentRow>(
      `select ${COLUMNS} from public.employee_documents where id = $1`,
      [id],
    )
    if (!rows[0]) throw new Error('document vanished inside its transaction')
    return rows[0]
  }

  /** Takes the next version of the document, or answers 404/412 as the other writes do. */
  const bumpVersion = async (
    client: PoolClient,
    id: string,
    employeeId: string,
    version: number,
  ): Promise<void> => {
    const { rowCount } = await client.query(
      `update public.employee_documents set version = version + 1, updated_at = now()
       where id = $1 and employee_id = $2 and version = $3`,
      [id, employeeId, version],
    )
    if (!rowCount) await missingOrStale(client, id, employeeId)
  }

  app.get<{ Params: Params }>(`${base}/:document/file`, async (request, reply) => {
    const session = requireSession(request)
    const file = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<{
        file_name: string
        content_type: string
        data: Buffer
        version: number
      }>(
        `select f.file_name, f.content_type, f.data, d.version
         from public.employee_document_files f
         join public.employee_documents d on d.id = f.document_id
         where d.id = $1 and d.employee_id = $2`,
        [id, employeeId],
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
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      await bumpVersion(client, id, employeeId, version)
      const { rowCount } = await client.query(
        'delete from public.employee_document_files where document_id = $1',
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
          if (!permissions.has('employees.update')) throw forbidden()
          const employeeId = await visibleEmployee(client, request.params.employee)
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
          await bumpVersion(client, id, employeeId, version)
          await client.query('delete from public.employee_document_files where document_id = $1', [
            id,
          ])
          await client.query(
            `insert into public.employee_document_files
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
