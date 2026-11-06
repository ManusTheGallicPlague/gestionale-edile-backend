import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { isValidPersonalCodiceFiscale, normalizeTaxId } from '../clients/tax-ids.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface EmployeeValues {
  first_name: string
  last_name: string
  tax_code: string | null
  job_title: string | null
  phone: string | null
  email: string | null
  hired_on: string | null
  hourly_cost_cents: string | null
  active: boolean
  notes: string | null
}
const COLUMNS = [
  'first_name',
  'last_name',
  'tax_code',
  'job_title',
  'phone',
  'email',
  'hired_on',
  'hourly_cost_cents',
  'active',
  'notes',
] as const

interface EmployeeRow extends EmployeeValues {
  id: string
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; employee?: string }

const SELECT = `select e.id, e.first_name, e.last_name, e.tax_code, e.job_title, e.phone, e.email,
    e.hired_on::text as hired_on, e.hourly_cost_cents::text as hourly_cost_cents, e.active,
    e.notes, e.version, e.created_at, e.updated_at
  from public.employees e`

const SORTS = {
  last_name: 'lower(e.last_name) asc, lower(e.first_name) asc, e.id asc',
  '-last_name': 'lower(e.last_name) desc, lower(e.first_name) desc, e.id desc',
  hired_on: 'e.hired_on asc nulls last, e.id asc',
  '-hired_on': 'e.hired_on desc nulls last, e.id desc',
  updated_at: 'e.updated_at asc, e.id asc',
  '-updated_at': 'e.updated_at desc, e.id desc',
} as const

function toContract(row: EmployeeRow) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    tax_code: row.tax_code,
    job_title: row.job_title,
    phone: row.phone,
    email: row.email,
    hired_on: row.hired_on,
    hourly_cost: row.hourly_cost_cents === null ? null : centsToAmount(row.hourly_cost_cents),
    active: row.active,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: EmployeeRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.employeeMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

export function parseEmployeeInput(
  body: unknown,
): { input: EmployeeValues } | { errors: FieldErrors } {
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
  const first_name = text('first_name', 100)
  if (first_name === null && !errors.first_name) add('first_name', 'Il nome è obbligatorio.')
  const last_name = text('last_name', 100)
  if (last_name === null && !errors.last_name) add('last_name', 'Il cognome è obbligatorio.')
  const taxText = text('tax_code', 20)
  const tax_code = taxText === null ? null : normalizeTaxId(taxText)
  if (tax_code !== null && !errors.tax_code && !isValidPersonalCodiceFiscale(tax_code)) {
    add('tax_code', 'Codice fiscale non valido.')
  }
  const job_title = text('job_title', 100)
  const phone = text('phone', 30)
  if (phone !== null && !errors.phone && !/^[0-9+()./ -]+$/.test(phone)) {
    add('phone', 'Il telefono può contenere solo numeri, spazi e + ( ) . / -')
  }
  const email = text('email', 254)?.toLowerCase() ?? null
  if (email !== null && !errors.email && !EMAIL.test(email)) add('email', 'Indirizzo non valido.')
  const hired_on = text('hired_on', 10)
  if (hired_on !== null && !errors.hired_on && !isIsoDate(hired_on)) {
    add('hired_on', 'Data non valida (AAAA-MM-GG).')
  }
  const costText = text('hourly_cost', 20)
  let hourly_cost_cents: string | null = null
  if (costText !== null && !errors.hourly_cost) {
    hourly_cost_cents = amountToCents(costText)
    if (hourly_cost_cents === null) add('hourly_cost', 'Importo non valido (es. 28.50).')
  }
  if (typeof raw.active !== 'boolean') add('active', 'Vale true oppure false.')
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !first_name || !last_name) return { errors }
  return {
    input: {
      first_name,
      last_name,
      tax_code,
      job_title,
      phone,
      email,
      hired_on,
      hourly_cost_cents,
      active: raw.active === true,
      notes,
    },
  }
}

function writeFailed(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({
      tax_code: ['Esiste già un dipendente con questo codice fiscale.'],
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
  const sortValue = single('sort') ?? 'last_name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const activeValue = single('filter[active]')
  if (activeValue !== undefined && activeValue !== 'true' && activeValue !== 'false') {
    errors['filter[active]'] = ['Vale true oppure false.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  const active = activeValue === undefined ? undefined : activeValue === 'true'
  return { page, perPage, sort: sort ?? 'last_name', search, active }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.active !== undefined) add((p) => `e.active = ${p}`, list.active)
  if (list.search) {
    add(
      (p) =>
        `(e.first_name || ' ' || e.last_name ilike ${p} or e.last_name || ' ' || e.first_name ilike ${p}
          or e.job_title ilike ${p} or e.tax_code ilike ${p})`,
      `%${escapeLike(list.search)}%`,
    )
  }
  return { where, values }
}

async function readOne(client: PoolClient, id: string) {
  const { rows } = await client.query<EmployeeRow>(`${SELECT} where e.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.employeeStale, 'stale_record')
}

export function employeeRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/employees'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<EmployeeRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.employees e where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(toContract),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
      }
    })
  })

  app.get<{ Params: Params }>(`${base}/:employee`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const id = request.params.employee ?? ''
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
      if (!permissions.has('employees.create')) throw forbidden()
      const parsed = parseEmployeeInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.employees (company_id, ${COLUMNS.join(', ')})
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

  app.put<{ Params: Params }>(`${base}/:employee`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const id = request.params.employee ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseEmployeeInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = COLUMNS.map((f) => parsed.input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.employees
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

  app.delete<{ Params: Params }>(`${base}/:employee`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.delete')) throw forbidden()
      const id = request.params.employee ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client
        .query('delete from public.employees where id = $1 and version = $2', [id, version])
        .catch((error: unknown) => {
          // The site team and, later, daily reports point here with "on delete restrict".
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.employeeHasDocuments, 'has_documents')
          }
          throw error
        })
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
