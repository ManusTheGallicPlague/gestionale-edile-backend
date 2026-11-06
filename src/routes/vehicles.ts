import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
import { italianAmount, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
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
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; vehicle?: string }

const SELECT = `select v.id, v.name, v.kind, v.plate, v.model,
    v.hourly_cost_cents::text as hourly_cost_cents, v.active, v.notes, v.version, v.created_at,
    v.updated_at
  from public.vehicles v`

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
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  const active = activeValue === undefined ? undefined : activeValue === 'true'
  return { page, perPage, sort: sort ?? 'name', search, active, kind }
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
          ['Nome', 'Tipo', 'Targa', 'Marca e modello', 'Costo orario', 'In uso', 'Note'],
          rows.map((r) => [
            r.name,
            KIND_LABELS[r.kind],
            r.plate,
            r.model,
            r.hourly_cost_cents && italianAmount(r.hourly_cost_cents),
            r.active ? 'Sì' : 'No',
            r.notes,
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
