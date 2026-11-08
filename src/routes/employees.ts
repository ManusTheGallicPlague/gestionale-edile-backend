import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
import { italianAmount, italianDate, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
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
import { csvScope } from '../http/files.js'
import { ImportFailed } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { employeeRowMessages, parseEmployeesCsv } from '../employees/import.js'

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
  /** Absent from the input: null on create, unchanged on update. */
  annual_leave_days?: number | null
  /** Absent from the input: null on create, unchanged on update. */
  annual_permit_hours?: number | null
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
  annual_leave_days: number | null
  annual_permit_hours: number | null
  id: string
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; employee?: string }

const SELECT = `select e.id, e.first_name, e.last_name, e.tax_code, e.job_title, e.phone, e.email,
    e.hired_on::text as hired_on, e.hourly_cost_cents::text as hourly_cost_cents, e.active,
    e.notes, e.annual_leave_days, e.annual_permit_hours, e.version, e.created_at, e.updated_at
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
    annual_leave_days: row.annual_leave_days,
    annual_permit_hours: row.annual_permit_hours,
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
  const whole = (name: string, max: number, message: string) => {
    const value = raw[name]
    if (
      value !== undefined &&
      value !== null &&
      !(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max)
    ) {
      add(name, message)
    }
    return value as number | null | undefined
  }
  const leave = whole('annual_leave_days', 366, 'Un numero intero di giorni da 0 a 366.')
  const permit = whole('annual_permit_hours', 2000, 'Un numero intero di ore da 0 a 2000.')
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
      ...(leave === undefined ? {} : { annual_leave_days: leave }),
      ...(permit === undefined ? {} : { annual_permit_hours: permit }),
    },
  }
}

/** Columns written only when the input has them, kept as they are on update otherwise. */
const OPTIONAL = ['annual_leave_days', 'annual_permit_hours'] as const

const columnsOf = (input: EmployeeValues): (keyof EmployeeValues)[] => [
  ...COLUMNS,
  ...OPTIONAL.filter((f) => input[f] !== undefined),
]

const placeholders = (columns: readonly string[]) => columns.map((_, i) => `$${i + 1}`).join(', ')

function writeFailed(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({
      tax_code: ['Esiste già un dipendente con questo codice fiscale.'],
    })
  }
  throw error
}

export const DOCUMENT_FILTERS = ['expired', 'expiring'] as const

const TODAY = "(now() at time zone 'Europe/Rome')::date"

/**
 * The latest expiry of each kind of document of the employee aliased `e`: an old course that
 * expired does not count once the refresher is on file. Documents without expiry are left out.
 */
const LATEST_EXPIRIES = `
  select max(d.expires_on) as expires_on from public.employee_documents d
  where d.employee_id = e.id and d.expires_on is not null group by d.kind`

/**
 * True if an employee aliased `e` has, on the given day (a SQL date expression), the latest
 * document of some kind already expired: the `expired` condition at another date.
 */
export function employeeDocumentsExpiredOn(day: string): string {
  return `exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on < ${day})`
}

/** Conditions on an employee aliased `e`, also counted in the dashboard. */
export const EMPLOYEE_DOCUMENTS_SQL: Record<(typeof DOCUMENT_FILTERS)[number], string> = {
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
  const sortValue = single('sort') ?? 'last_name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const activeValue = single('filter[active]')
  if (activeValue !== undefined && activeValue !== 'true' && activeValue !== 'false') {
    errors['filter[active]'] = ['Vale true oppure false.']
  }
  const documentsValue = single('filter[documents]')
  const documents = DOCUMENT_FILTERS.find((d) => d === documentsValue)
  if (documentsValue !== undefined && !documents) {
    errors['filter[documents]'] = ['Vale expired oppure expiring.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  const active = activeValue === undefined ? undefined : activeValue === 'true'
  return { page, perPage, sort: sort ?? 'last_name', search, active, documents }
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
  if (list.documents) where.push(EMPLOYEE_DOCUMENTS_SQL[list.documents])
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

  csvScope(app, config, (scope) => {
    scope.post<{ Params: Params }>(`${base}/import`, async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('employees.create')) throw forbidden()
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(415, 'Il corpo deve essere un file CSV (text/csv).')
        }
        let employees
        try {
          employees = parseEmployeesCsv(body, parseEmployeeInput)
        } catch (error) {
          if (error instanceof ImportFailed) throw new ValidationFailed(error.errors)
          throw error
        }
        // One savepoint per row, so a duplicate tax code is reported on its row.
        const errors = new RowErrors()
        for (const { line, input } of employees) {
          const columns = columnsOf(input)
          await client.query('savepoint import_row')
          try {
            await client.query(
              `insert into public.employees (company_id, ${columns.join(', ')})
               values (app.current_company_id(), ${placeholders(columns)})`,
              columns.map((f) => input[f]),
            )
            await client.query('release savepoint import_row')
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            await client.query('rollback to savepoint import_row')
            errors.add(
              line,
              employeeRowMessages({
                tax_code: ['Esiste già un dipendente con questo codice fiscale.'],
              }),
            )
          }
        }
        if (!errors.empty) throw new ValidationFailed(errors.errors)
        return { created: employees.length }
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
        if (!permissions.has('employees.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<EmployeeRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Cognome',
            'Nome',
            'Codice fiscale',
            'Mansione',
            'Telefono',
            'Email',
            'Assunzione',
            'Costo orario',
            'Attivo',
            'Note',
            'Ferie annue',
            'Permessi annui',
          ],
          rows.map((r) => [
            r.last_name,
            r.first_name,
            r.tax_code,
            r.job_title,
            r.phone,
            r.email,
            r.hired_on && italianDate(r.hired_on),
            r.hourly_cost_cents && italianAmount(r.hourly_cost_cents),
            r.active ? 'Sì' : 'No',
            r.notes,
            r.annual_leave_days,
            r.annual_permit_hours,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="dipendenti.csv"')
        .send(csv)
    },
  )

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
      const columns = columnsOf(parsed.input)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.employees (company_id, ${columns.join(', ')})
           values (app.current_company_id(), ${placeholders(columns)})
           returning id`,
          columns.map((f) => parsed.input[f]),
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
      const columns = columnsOf(parsed.input)
      const values: unknown[] = columns.map((f) => parsed.input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.employees
           set ${columns.map((f, i) => `${f} = $${i + 1}`).join(', ')},
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
