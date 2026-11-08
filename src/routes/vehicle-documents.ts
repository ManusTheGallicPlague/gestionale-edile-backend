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

export const VEHICLE_DOCUMENT_KINDS = [
  'insurance',
  'road_tax',
  'registration',
  'tachograph',
  'other',
] as const
export type VehicleDocumentKind = (typeof VEHICLE_DOCUMENT_KINDS)[number]

/** Names of the kinds in the titles of the deadlines. */
const KIND_LABEL: Record<VehicleDocumentKind, string> = {
  insurance: 'Assicurazione',
  road_tax: 'Bollo',
  registration: 'Carta di circolazione',
  tachograph: 'Taratura del tachigrafo',
  other: 'Documento',
}

interface DocumentRow extends DocumentInput<VehicleDocumentKind> {
  id: string
  vehicle_id: string
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry'
  version: number
  created_at: Date
  updated_at: Date
}

// Dates leave the database as text: a JavaScript Date would shift them with the time zone.
// "Today" is the Italian one, not the server's.
const COLUMNS = `id, vehicle_id, kind, description, issued_on::text as issued_on,
  expires_on::text as expires_on, notes, version, created_at, updated_at,
  case
    when expires_on is null then 'no_expiry'
    when expires_on < (now() at time zone 'Europe/Rome')::date then 'expired'
    when expires_on <= (now() at time zone 'Europe/Rome')::date + 30 then 'expiring'
    else 'valid'
  end as status`

type Params = { company: string; vehicle?: string; document?: string }

function toContract(row: DocumentRow) {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
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

/** The vehicle in the path, if this company can see it; 404 otherwise. */
async function visibleVehicle(client: PoolClient, id: string | undefined): Promise<string> {
  if (!id || !UUID.test(id)) throw notFound()
  const { rowCount } = await client.query('select 1 from public.vehicles where id = $1', [id])
  if (!rowCount) throw notFound()
  return id
}

async function missingOrStale(client: PoolClient, id: string, vehicleId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.vehicle_documents where id = $1 and vehicle_id = $2',
    [id, vehicleId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.documentStale, 'stale_record')
}

/**
 * Keeps the document's deadline in step: one deadline of the vehicle on the expiry date; none
 * when the document does not expire. A new expiry date (a renewal) reopens it.
 */
async function syncDeadline(client: PoolClient, documentId: string): Promise<void> {
  await client.query(
    `delete from public.deadlines d using public.vehicle_documents vd
     where d.vehicle_document_id = vd.id and vd.id = $1 and vd.expires_on is null`,
    [documentId],
  )
  await client.query(
    `insert into public.deadlines (company_id, title, due_on, kind, vehicle_id, vehicle_document_id)
     select vd.company_id,
       left(coalesce(vd.description, case vd.kind
         when 'insurance' then $2 when 'road_tax' then $3 when 'registration' then $4
         when 'tachograph' then $5 else $6 end) || ' – ' || v.name, 200),
       vd.expires_on, 'vehicle', vd.vehicle_id, vd.id
     from public.vehicle_documents vd
     join public.vehicles v on v.id = vd.vehicle_id
     where vd.id = $1 and vd.expires_on is not null
     on conflict (vehicle_document_id) do update set
       title = excluded.title,
       status = case when deadlines.due_on = excluded.due_on then deadlines.status else 'open' end,
       done_at = case when deadlines.due_on = excluded.due_on then deadlines.done_at end,
       due_on = excluded.due_on,
       version = deadlines.version + 1, updated_at = now()
     where deadlines.title is distinct from excluded.title
        or deadlines.due_on is distinct from excluded.due_on`,
    [
      documentId,
      KIND_LABEL.insurance,
      KIND_LABEL.road_tax,
      KIND_LABEL.registration,
      KIND_LABEL.tachograph,
      KIND_LABEL.other,
    ],
  )
}

const parse = (body: unknown) => parseDocumentInput(body, VEHICLE_DOCUMENT_KINDS)

export function vehicleDocumentRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/vehicles/:vehicle/documents'

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.view')) throw notFound()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const { rows } = await client.query<DocumentRow>(
        `select ${COLUMNS} from public.vehicle_documents
         where vehicle_id = $1
         order by expires_on asc nulls last, created_at asc, id asc`,
        [vehicleId],
      )
      return { data: rows.map(toContract) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const parsed = parse(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values = [vehicleId, ...DOCUMENT_FIELDS.map((f) => parsed.input[f])]
      const { rows } = await client.query<DocumentRow>(
        `insert into public.vehicle_documents (company_id, vehicle_id, ${DOCUMENT_FIELDS.join(', ')})
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
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parse(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = DOCUMENT_FIELDS.map((f) => parsed.input[f])
      values.push(id, vehicleId, version)
      const n = values.length
      const { rows } = await client.query<DocumentRow>(
        `update public.vehicle_documents
         set ${DOCUMENT_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $${n - 2} and vehicle_id = $${n - 1} and version = $${n}
         returning ${COLUMNS}`,
        values,
      )
      if (!rows[0]) return missingOrStale(client, id, vehicleId)
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
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.document ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.vehicle_documents where id = $1 and vehicle_id = $2 and version = $3',
        [id, vehicleId, version],
      )
      if (!rowCount) await missingOrStale(client, id, vehicleId)
    })
    return reply.code(204).send()
  })
}
