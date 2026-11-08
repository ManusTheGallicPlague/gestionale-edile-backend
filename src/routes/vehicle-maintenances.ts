import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { amountToCents, centsToAmount } from '../money.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MAX_EXPORT_ROWS, italianAmount, italianDate, toCsv } from '../csv.js'

export const MAINTENANCE_KINDS = ['service', 'repair', 'inspection', 'tires', 'other'] as const
type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number]

/** Names of the kinds in the CSV file. */
const KIND_NAMES: Record<MaintenanceKind, string> = {
  service: 'Tagliando',
  repair: 'Riparazione',
  inspection: 'Revisione',
  tires: 'Gomme',
  other: 'Altro',
}

interface MaintenanceInput {
  performed_on: string
  kind: MaintenanceKind
  description: string
  supplier_id: string | null
  amount_cents: string | null
  meter_reading: number | null
  notes: string | null
}

interface MaintenanceRow extends MaintenanceInput {
  id: string
  vehicle_id: string
  supplier_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; vehicle?: string; maintenance?: string }

const FIELDS = [
  'performed_on',
  'kind',
  'description',
  'supplier_id',
  'amount_cents',
  'meter_reading',
  'notes',
] as const

/** The fields of the request body: the amount travels in euros, not in cents. */
const INPUT_FIELDS = [
  'performed_on',
  'kind',
  'description',
  'supplier_id',
  'amount',
  'meter_reading',
  'notes',
] as const

// Dates leave the database as text: a JavaScript Date would shift them with the time zone.
const SELECT = `select m.id, m.vehicle_id, m.performed_on::text as performed_on, m.kind,
    m.description, m.supplier_id, s.name as supplier_name,
    m.amount_cents::text as amount_cents, m.meter_reading, m.notes, m.version,
    m.created_at, m.updated_at
  from public.vehicle_maintenances m
  left join public.suppliers s on s.id = m.supplier_id`

function toContract(row: MaintenanceRow) {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
    performed_on: row.performed_on,
    kind: row.kind,
    description: row.description,
    supplier_id: row.supplier_id,
    supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? '' } : null,
    amount: row.amount_cents === null ? null : centsToAmount(row.amount_cents),
    meter_reading: row.meter_reading,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: MaintenanceRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

export function parseMaintenanceInput(body: unknown): MaintenanceInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  const raw = body as Record<string, unknown>
  for (const field of Object.keys(raw)) {
    if (!(INPUT_FIELDS as readonly string[]).includes(field)) {
      add(field, 'Campo non previsto.')
    }
  }
  const text = (field: string, max: number): string | null => {
    if (!(field in raw)) {
      add(field, 'Campo mancante.')
      return null
    }
    const value = raw[field]
    if (value === null) return null
    if (typeof value !== 'string') {
      add(field, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) add(field, `Al massimo ${max} caratteri.`)
    return trimmed === '' ? null : trimmed
  }

  const performed_on = text('performed_on', 10)
  if (performed_on === null && !errors.performed_on) add('performed_on', 'Indica la data.')
  else if (performed_on !== null && !isIsoDate(performed_on)) {
    add('performed_on', 'Data non valida: usa il formato AAAA-MM-GG.')
  }

  const kindValue = text('kind', 20)
  const kind = MAINTENANCE_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Scegli il tipo di manutenzione.')

  const description = text('description', 300)
  if (description === null && !errors.description) add('description', 'Descrivi il lavoro.')

  const supplier_id = text('supplier_id', 36)
  if (supplier_id !== null && !UUID.test(supplier_id) && !errors.supplier_id) {
    add('supplier_id', 'Fornitore non trovato.')
  }

  const amountText = text('amount', 20)
  let amount_cents: string | null = null
  if (amountText !== null && !errors.amount) {
    amount_cents = amountToCents(amountText)
    if (amount_cents === null) add('amount', 'Importo non valido (es. 1234.50).')
  }

  let meter_reading: number | null = null
  if (!('meter_reading' in raw)) add('meter_reading', 'Campo mancante.')
  else if (raw.meter_reading !== null) {
    const value = raw.meter_reading
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9999999) {
      add('meter_reading', 'Un numero intero da 0 a 9999999 (km o ore motore), o null.')
    } else meter_reading = value
  }

  const notes = text('notes', 2000)

  if (Object.keys(errors).length > 0 || !performed_on || !kind || !description) {
    throw new ValidationFailed(errors)
  }
  return { performed_on, kind, description, supplier_id, amount_cents, meter_reading, notes }
}

function readPeriod(query: Record<string, unknown>, withVehicle = false) {
  const errors: FieldErrors = {}
  const date = (name: string): string | null => {
    const value = query[`filter[${name}]`]
    if (value === undefined) return null
    if (typeof value !== 'string') {
      errors[`filter[${name}]`] = ['Indicalo una volta sola.']
      return null
    }
    if (!isIsoDate(value)) {
      errors[`filter[${name}]`] = ['Data non valida (AAAA-MM-GG).']
      return null
    }
    return value
  }
  const from = date('from')
  const to = date('to')
  if (from && to && to < from) errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  let vehicle: string | null = null
  if (withVehicle) {
    const value = query['filter[vehicle]']
    if (typeof value === 'string' && UUID.test(value)) vehicle = value.toLowerCase()
    else if (value !== undefined) errors['filter[vehicle]'] = ['Identificativo non valido.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { from, to, vehicle }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.maintenanceMissingIfMatch, 'precondition_required')
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

/** The workshop must be a supplier of the company: 422 under its field otherwise. */
async function checkSupplier(client: PoolClient, input: MaintenanceInput): Promise<void> {
  if (!input.supplier_id) return
  const { rowCount } = await client.query('select 1 from public.suppliers where id = $1', [
    input.supplier_id,
  ])
  if (!rowCount) throw new ValidationFailed({ supplier_id: ['Fornitore non trovato.'] })
}

async function readOne(client: PoolClient, id: string): Promise<MaintenanceRow> {
  const { rows } = await client.query<MaintenanceRow>(`${SELECT} where m.id = $1`, [id])
  const row = rows[0]
  if (!row) throw new Error('maintenance not found after write')
  return row
}

async function missingOrStale(client: PoolClient, id: string, vehicleId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.vehicle_maintenances where id = $1 and vehicle_id = $2',
    [id, vehicleId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.maintenanceStale, 'stale_record')
}

export function vehicleMaintenanceRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/vehicle-maintenances/export',
    async (request, reply) => {
      const session = requireSession(request)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('vehicles.view')) throw forbidden()
        const { from, to, vehicle } = readPeriod(request.query, true)
        const { rows } = await client.query<
          MaintenanceRow & { vehicle_name: string; plate: string | null }
        >(
          `select m.performed_on::text as performed_on, m.kind, m.description,
             s.name as supplier_name, m.amount_cents::text as amount_cents, m.meter_reading,
             m.notes, v.name as vehicle_name, v.plate
           from public.vehicle_maintenances m
           join public.vehicles v on v.id = m.vehicle_id
           left join public.suppliers s on s.id = m.supplier_id
           where ($1::date is null or m.performed_on >= $1)
             and ($2::date is null or m.performed_on <= $2)
             and ($3::uuid is null or m.vehicle_id = $3)
           order by m.performed_on desc, v.name, m.created_at desc, m.id desc
           limit $4`,
          [from, to, vehicle, MAX_EXPORT_ROWS],
        )
        return toCsv(
          [
            'Data',
            'Mezzo',
            'Targa',
            'Tipo',
            'Descrizione',
            'Officina',
            'Km o ore',
            'Spesa',
            'Note',
          ],
          rows.map((r) => [
            italianDate(r.performed_on),
            r.vehicle_name,
            r.plate,
            KIND_NAMES[r.kind],
            r.description,
            r.supplier_name,
            r.meter_reading,
            r.amount_cents === null ? null : italianAmount(r.amount_cents),
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="manutenzioni.csv"')
        .send(csv)
    },
  )

  const base = '/api/companies/:company/vehicles/:vehicle/maintenances'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.view')) throw notFound()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const { from, to } = readPeriod(request.query)
      const { rows } = await client.query<MaintenanceRow>(
        `${SELECT}
         where m.vehicle_id = $1
           and ($2::date is null or m.performed_on >= $2) and ($3::date is null or m.performed_on <= $3)
         order by m.performed_on desc, m.created_at desc, m.id desc`,
        [vehicleId, from, to],
      )
      let total = 0n
      for (const r of rows) if (r.amount_cents !== null) total += BigInt(r.amount_cents)
      return { data: rows.map(toContract), total_amount: centsToAmount(total.toString()) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const input = parseMaintenanceInput(request.body)
      await checkSupplier(client, input)
      const { rows } = await client.query<{ id: string }>(
        `insert into public.vehicle_maintenances (company_id, vehicle_id, ${FIELDS.join(', ')})
         values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [vehicleId, ...FIELDS.map((f) => input[f])],
      )
      return readOne(client, rows[0]?.id ?? '')
    })
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:maintenance`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.maintenance ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseMaintenanceInput(request.body)
      await checkSupplier(client, input)
      const { rowCount } = await client.query(
        `update public.vehicle_maintenances
         set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $8 and vehicle_id = $9 and version = $10`,
        [...FIELDS.map((f) => input[f]), id, vehicleId, version],
      )
      if (!rowCount) await missingOrStale(client, id, vehicleId)
      return readOne(client, id)
    })
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:maintenance`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.maintenance ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.vehicle_maintenances where id = $1 and vehicle_id = $2 and version = $3',
        [id, vehicleId, version],
      )
      if (!rowCount) await missingOrStale(client, id, vehicleId)
    })
    return reply.code(204).send()
  })
}
