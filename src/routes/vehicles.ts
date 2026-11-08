import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
import { italianAmount, italianDate, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import { MAINTENANCE_KIND_NAMES, type MaintenanceKind } from './vehicle-maintenances.js'
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
import { csvScope } from '../http/files.js'
import { ImportFailed } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { parseVehiclesCsv, vehicleRowMessages } from '../vehicles/import.js'

export const VEHICLE_KINDS = ['vehicle', 'machine', 'equipment'] as const
type Kind = (typeof VEHICLE_KINDS)[number]
const KIND_LABELS: Record<Kind, string> = {
  vehicle: 'Automezzo',
  machine: 'Macchina operatrice',
  equipment: 'Attrezzatura',
}

interface VehicleValues {
  name: string
  kind: Kind
  plate: string | null
  model: string | null
  hourly_cost_cents: string | null
  active: boolean
  notes: string | null
}
const COLUMNS = ['name', 'kind', 'plate', 'model', 'hourly_cost_cents', 'active', 'notes'] as const

interface VehicleRow extends VehicleValues {
  id: string
  last_maintenance_id: string | null
  last_maintenance_on: string | null
  last_maintenance_kind: MaintenanceKind | null
  last_meter_reading: number | null
  last_next_due_on: string | null
  last_refueling_id: string | null
  last_refueling_on: string | null
  last_refueling_liters: string | null
  last_refueling_meter_reading: number | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; vehicle?: string }

const SELECT = `select v.id, v.name, v.kind, v.plate, v.model,
    v.hourly_cost_cents::text as hourly_cost_cents, v.active, v.notes, v.version, v.created_at,
    v.updated_at, m.id as last_maintenance_id, m.performed_on::text as last_maintenance_on,
    m.kind as last_maintenance_kind, m.meter_reading as last_meter_reading,
    m.next_due_on::text as last_next_due_on, f.id as last_refueling_id,
    f.refueled_on::text as last_refueling_on, f.liters::text as last_refueling_liters,
    f.meter_reading as last_refueling_meter_reading
  from public.vehicles v
  left join lateral (
    select vm.id, vm.performed_on, vm.kind, vm.meter_reading, vm.next_due_on
    from public.vehicle_maintenances vm
    where vm.vehicle_id = v.id and vm.company_id = v.company_id
    order by vm.performed_on desc, vm.created_at desc, vm.id desc
    limit 1
  ) m on true
  left join lateral (
    select vr.id, vr.refueled_on, vr.liters, vr.meter_reading
    from public.vehicle_refuelings vr
    where vr.vehicle_id = v.id and vr.company_id = v.company_id
    order by vr.refueled_on desc, vr.created_at desc, vr.id desc
    limit 1
  ) f on true`

const SORTS = {
  name: 'lower(v.name) asc, v.id asc',
  '-name': 'lower(v.name) desc, v.id desc',
  updated_at: 'v.updated_at asc, v.id asc',
  '-updated_at': 'v.updated_at desc, v.id desc',
} as const

function toContract(row: VehicleRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    plate: row.plate,
    model: row.model,
    hourly_cost: row.hourly_cost_cents === null ? null : centsToAmount(row.hourly_cost_cents),
    active: row.active,
    notes: row.notes,
    last_maintenance:
      row.last_maintenance_id === null
        ? null
        : {
            id: row.last_maintenance_id,
            performed_on: row.last_maintenance_on,
            kind: row.last_maintenance_kind,
            meter_reading: row.last_meter_reading,
            next_due_on: row.last_next_due_on,
          },
    last_refueling:
      row.last_refueling_id === null
        ? null
        : {
            id: row.last_refueling_id,
            refueled_on: row.last_refueling_on,
            liters: row.last_refueling_liters,
            meter_reading: row.last_refueling_meter_reading,
          },
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: VehicleRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.vehicleMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

export function parseVehicleInput(
  body: unknown,
): { input: VehicleValues } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>
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
  const name = text('name', 200)
  if (name === null && !errors.name) add('name', 'Il nome è obbligatorio.')
  const kindValue = text('kind', 20)
  const kind = VEHICLE_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Tipo non valido.')
  const plateText = text('plate', 20)
  const plate = plateText === null ? null : plateText.replace(/[\s.-]/g, '').toUpperCase()
  if (plate !== null && !errors.plate && !/^[A-Z0-9]{1,10}$/.test(plate)) {
    add('plate', 'Targa non valida: solo lettere e cifre, al massimo 10.')
  }
  const model = text('model', 200)
  const costText = text('hourly_cost', 20)
  let hourly_cost_cents: string | null = null
  if (costText !== null && !errors.hourly_cost) {
    hourly_cost_cents = amountToCents(costText)
    if (hourly_cost_cents === null) add('hourly_cost', 'Importo non valido (es. 45.00).')
  }
  if (typeof raw.active !== 'boolean') add('active', 'Vale true oppure false.')
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !name || !kind) return { errors }
  return {
    input: { name, kind, plate, model, hourly_cost_cents, active: raw.active === true, notes },
  }
}

function writeFailed(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({
      plate: ['Esiste già un mezzo con questa targa.'],
    })
  }
  throw error
}

const DOCUMENT_FILTERS = ['expired', 'expiring'] as const

const TODAY = "(now() at time zone 'Europe/Rome')::date"

/**
 * The latest expiry of each kind of document of the vehicle: an old insurance that expired
 * does not count once the renewal is on file. Documents without expiry are left out.
 */
const LATEST_EXPIRIES = `
  select max(d.expires_on) as expires_on from public.vehicle_documents d
  where d.vehicle_id = v.id and d.expires_on is not null group by d.kind`

const DOCUMENTS_SQL: Record<(typeof DOCUMENT_FILTERS)[number], string> = {
  expired: `exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on < ${TODAY})`,
  expiring: `not exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on < ${TODAY})
    and exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on <= ${TODAY} + 30)`,
}

function readList(query: Record<string, unknown>) {
  const errors: FieldErrors = {}
  const single = (name: string): string | undefined => {
    const value = query[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      errors[name] = ['Indicalo una volta sola.']
      return undefined
    }
    return value
  }
  const integer = (name: string, fallback: number, max?: number): number => {
    const value = single(name)
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
  const sortValue = single('sort') ?? 'name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const activeValue = single('filter[active]')
  if (activeValue !== undefined && activeValue !== 'true' && activeValue !== 'false') {
    errors['filter[active]'] = ['Vale true oppure false.']
  }
  const kindValue = single('filter[kind]')
  const kind = VEHICLE_KINDS.find((k) => k === kindValue)
  if (kindValue !== undefined && !kind) errors['filter[kind]'] = ['Tipo non valido.']
  const documentsValue = single('filter[documents]')
  const documents = DOCUMENT_FILTERS.find((d) => d === documentsValue)
  if (documentsValue !== undefined && !documents) {
    errors['filter[documents]'] = ['Vale expired oppure expiring.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  const active = activeValue === undefined ? undefined : activeValue === 'true'
  return { page, perPage, sort: sort ?? 'name', search, active, kind, documents }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.active !== undefined) add((p) => `v.active = ${p}`, list.active)
  if (list.kind) add((p) => `v.kind = ${p}`, list.kind)
  if (list.documents) where.push(DOCUMENTS_SQL[list.documents])
  if (list.search) {
    add(
      (p) => `(v.name ilike ${p} or v.plate ilike ${p} or v.model ilike ${p})`,
      `%${escapeLike(list.search)}%`,
    )
  }
  return { where, values }
}

async function readOne(client: PoolClient, id: string) {
  const { rows } = await client.query<VehicleRow>(`${SELECT} where v.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.vehicleStale, 'stale_record')
}

export function vehicleRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/vehicles'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<VehicleRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.vehicles v where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(toContract),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
      }
    })
  })

  csvScope(app, config, (scope) => {
    scope.post<{ Params: Params }>(`${base}/import`, async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('vehicles.create')) throw forbidden()
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(415, 'Il corpo deve essere un file CSV (text/csv).')
        }
        let vehicles
        try {
          vehicles = parseVehiclesCsv(body, parseVehicleInput)
        } catch (error) {
          if (error instanceof ImportFailed) throw new ValidationFailed(error.errors)
          throw error
        }
        // One savepoint per row, so a duplicate plate is reported on its row.
        const errors = new RowErrors()
        const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ')
        for (const { line, input } of vehicles) {
          await client.query('savepoint import_row')
          try {
            await client.query(
              `insert into public.vehicles (company_id, ${COLUMNS.join(', ')})
               values (app.current_company_id(), ${placeholders})`,
              COLUMNS.map((f) => input[f]),
            )
            await client.query('release savepoint import_row')
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            await client.query('rollback to savepoint import_row')
            errors.add(
              line,
              vehicleRowMessages({ plate: ['Esiste già un mezzo con questa targa.'] }),
            )
          }
        }
        if (!errors.empty) throw new ValidationFailed(errors.errors)
        return { created: vehicles.length }
      })
    })
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('vehicles.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<VehicleRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Nome',
            'Tipo',
            'Targa',
            'Marca e modello',
            'Costo orario',
            'In uso',
            'Note',
            'Ultima manutenzione',
            'Tipo di manutenzione',
            'Contachilometri o contaore',
            'Ultimo rifornimento',
            'Litri',
            'Contachilometri o contaore al rifornimento',
          ],
          rows.map((r) => [
            r.name,
            KIND_LABELS[r.kind],
            r.plate,
            r.model,
            r.hourly_cost_cents && italianAmount(r.hourly_cost_cents),
            r.active ? 'Sì' : 'No',
            r.notes,
            r.last_maintenance_on && italianDate(r.last_maintenance_on),
            r.last_maintenance_kind && MAINTENANCE_KIND_NAMES[r.last_maintenance_kind],
            r.last_meter_reading,
            r.last_refueling_on && italianDate(r.last_refueling_on),
            r.last_refueling_liters && r.last_refueling_liters.replace('.', ','),
            r.last_refueling_meter_reading,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="mezzi.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:vehicle`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.view')) throw notFound()
      const id = request.params.vehicle ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.create')) throw forbidden()
      const parsed = parseVehicleInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.vehicles (company_id, ${COLUMNS.join(', ')})
           values (app.current_company_id(), ${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           returning id`,
          COLUMNS.map((f) => parsed.input[f]),
        )
        .catch(writeFailed)
      return readOne(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:vehicle`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.update')) throw forbidden()
      const id = request.params.vehicle ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseVehicleInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = COLUMNS.map((f) => parsed.input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.vehicles
           set ${COLUMNS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}`,
          values,
        )
        .catch(writeFailed)
      if (!rowCount) return missingOrStale(client, id)
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:vehicle`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('vehicles.delete')) throw forbidden()
      const id = request.params.vehicle ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client
        .query('delete from public.vehicles where id = $1 and version = $2', [id, version])
        .catch((error: unknown) => {
          // Daily reports point here with "on delete restrict".
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.vehicleHasDocuments, 'has_documents')
          }
          throw error
        })
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
