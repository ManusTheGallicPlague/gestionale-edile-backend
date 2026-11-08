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

interface RefuelingInput {
  refueled_on: string
  /** Text of a numeric with at most two decimals, never a JavaScript number. */
  liters: string
  amount_cents: string
  meter_reading: number | null
  supplier_id: string | null
  notes: string | null
}

interface RefuelingRow extends RefuelingInput {
  id: string
  vehicle_id: string
  supplier_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; vehicle?: string; refueling?: string }

const FIELDS = [
  'refueled_on',
  'liters',
  'amount_cents',
  'meter_reading',
  'supplier_id',
  'notes',
] as const

/** The fields of the request body: the amount travels in euros, not in cents. */
const INPUT_FIELDS = [
  'refueled_on',
  'liters',
  'amount',
  'meter_reading',
  'supplier_id',
  'notes',
] as const

/** Litres: up to six integer digits and two decimals, with the dot. */
const LITERS = /^\d{1,6}(\.\d{1,2})?$/

// Dates and numerics leave the database as text: no time zone shift, no floating point.
const SELECT = `select r.id, r.vehicle_id, r.refueled_on::text as refueled_on,
    r.liters::text as liters, r.amount_cents::text as amount_cents, r.meter_reading,
    r.supplier_id, s.name as supplier_name, r.notes, r.version, r.created_at, r.updated_at
  from public.vehicle_refuelings r
  left join public.suppliers s on s.id = r.supplier_id`

function toContract(row: RefuelingRow) {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
    refueled_on: row.refueled_on,
    liters: row.liters,
    amount: centsToAmount(row.amount_cents),
    meter_reading: row.meter_reading,
    supplier_id: row.supplier_id,
    supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? '' } : null,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: RefuelingRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

export function parseRefuelingInput(body: unknown): RefuelingInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  const raw = body as Record<string, unknown>
  for (const field of Object.keys(raw)) {
    if (!(INPUT_FIELDS as readonly string[]).includes(field)) add(field, 'Campo non previsto.')
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

  const refueled_on = text('refueled_on', 10)
  if (refueled_on === null && !errors.refueled_on) add('refueled_on', 'Indica la data.')
  else if (refueled_on !== null && !isIsoDate(refueled_on)) {
    add('refueled_on', 'Data non valida: usa il formato AAAA-MM-GG.')
  }

  const litersText = text('liters', 20)
  let liters: string | null = null
  if (litersText === null && !errors.liters) add('liters', 'Indica i litri.')
  else if (litersText !== null && !errors.liters) {
    if (!LITERS.test(litersText)) add('liters', 'Litri non validi (es. 45.20).')
    else if (!/[1-9]/.test(litersText)) add('liters', 'I litri devono essere più di zero.')
    else liters = litersText
  }

  const amountText = text('amount', 20)
  let amount_cents: string | null = null
  if (amountText === null && !errors.amount) add('amount', 'Indica la spesa.')
  else if (amountText !== null && !errors.amount) {
    amount_cents = amountToCents(amountText)
    if (amount_cents === null) add('amount', 'Importo non valido (es. 85.40).')
  }

  let meter_reading: number | null = null
  if (!('meter_reading' in raw)) add('meter_reading', 'Campo mancante.')
  else if (raw.meter_reading !== null) {
    const value = raw.meter_reading
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9999999) {
      add('meter_reading', 'Un numero intero da 0 a 9999999 (km o ore motore), o null.')
    } else meter_reading = value
  }

  const supplier_id = text('supplier_id', 36)
  if (supplier_id !== null && !UUID.test(supplier_id) && !errors.supplier_id) {
    add('supplier_id', 'Fornitore non trovato.')
  }

  const notes = text('notes', 2000)

  if (Object.keys(errors).length > 0 || !refueled_on || !liters || !amount_cents) {
    throw new ValidationFailed(errors)
  }
  return { refueled_on, liters, amount_cents, meter_reading, supplier_id, notes }
}

function readPeriod(query: Record<string, unknown>) {
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
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { from, to }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.refuelingMissingIfMatch, 'precondition_required')
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

/** The filling station must be a supplier of the company: 422 under its field otherwise. */
async function checkSupplier(client: PoolClient, input: RefuelingInput): Promise<void> {
  if (!input.supplier_id) return
  const { rowCount } = await client.query('select 1 from public.suppliers where id = $1', [
    input.supplier_id,
  ])
  if (!rowCount) throw new ValidationFailed({ supplier_id: ['Fornitore non trovato.'] })
}

async function readOne(client: PoolClient, id: string): Promise<RefuelingRow> {
  const { rows } = await client.query<RefuelingRow>(`${SELECT} where r.id = $1`, [id])
  const row = rows[0]
  if (!row) throw new Error('refueling not found after write')
  return row
}

async function missingOrStale(client: PoolClient, id: string, vehicleId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.vehicle_refuelings where id = $1 and vehicle_id = $2',
    [id, vehicleId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.refuelingStale, 'stale_record')
}

export function vehicleRefuelingRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/vehicles/:vehicle/refuelings'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.view')) throw notFound()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const { from, to } = readPeriod(request.query)
      const { rows } = await client.query<RefuelingRow>(
        `${SELECT}
         where r.vehicle_id = $1
           and ($2::date is null or r.refueled_on >= $2) and ($3::date is null or r.refueled_on <= $3)
         order by r.refueled_on desc, r.created_at desc, r.id desc`,
        [vehicleId, from, to],
      )
      // Sums in the database and in bigint: litres and cents never pass through a float.
      const { rows: totals } = await client.query<{ liters: string; cents: string }>(
        `select coalesce(sum(liters), 0)::numeric(14, 2)::text as liters,
           coalesce(sum(amount_cents), 0)::text as cents
         from public.vehicle_refuelings
         where vehicle_id = $1
           and ($2::date is null or refueled_on >= $2) and ($3::date is null or refueled_on <= $3)`,
        [vehicleId, from, to],
      )
      return {
        data: rows.map(toContract),
        total_liters: totals[0]?.liters ?? '0.00',
        total_amount: centsToAmount(totals[0]?.cents ?? '0'),
      }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const input = parseRefuelingInput(request.body)
      await checkSupplier(client, input)
      const { rows } = await client.query<{ id: string }>(
        `insert into public.vehicle_refuelings (company_id, vehicle_id, ${FIELDS.join(', ')})
         values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [vehicleId, ...FIELDS.map((f) => input[f])],
      )
      return readOne(client, rows[0]?.id ?? '')
    })
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:refueling`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.refueling ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseRefuelingInput(request.body)
      await checkSupplier(client, input)
      const { rowCount } = await client.query(
        `update public.vehicle_refuelings
         set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $7 and vehicle_id = $8 and version = $9`,
        [...FIELDS.map((f) => input[f]), id, vehicleId, version],
      )
      if (!rowCount) await missingOrStale(client, id, vehicleId)
      return readOne(client, id)
    })
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:refueling`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const vehicleId = await visibleVehicle(client, request.params.vehicle)
      const id = request.params.refueling ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.vehicle_refuelings where id = $1 and vehicle_id = $2 and version = $3',
        [id, vehicleId, version],
      )
      if (!rowCount) await missingOrStale(client, id, vehicleId)
    })
    return reply.code(204).send()
  })
}
