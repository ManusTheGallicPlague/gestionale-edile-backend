import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MAX_EXPORT_ROWS, italianDate, toCsv } from '../csv.js'
import { italianQuantity } from '../quotes/pdf.js'
import { toICalendar } from '../deadlines/ical.js'
import { workingDays } from '../holidays.js'

export const ABSENCE_KINDS = ['vacation', 'sick_leave', 'leave', 'injury', 'other'] as const
export type AbsenceKind = (typeof ABSENCE_KINDS)[number]

/** Codes of the absences in the monthly timesheet, as Italian payroll offices write them. */
export const ABSENCE_CODES: Record<AbsenceKind, string> = {
  vacation: 'FE',
  sick_leave: 'MA',
  leave: 'PE',
  injury: 'IN',
  other: 'AL',
}

/** Names of the absences in the CSV files. */
export const ABSENCE_NAMES: Record<AbsenceKind, string> = {
  vacation: 'Ferie',
  sick_leave: 'Malattia',
  leave: 'Permesso',
  injury: 'Infortunio',
  other: 'Altro',
}

interface AbsenceInput {
  kind: AbsenceKind
  starts_on: string
  ends_on: string
  hours: string | null
  notes: string | null
}

interface AbsenceRow extends AbsenceInput {
  id: string
  employee_id: string
  days: number
  version: number
  created_at: Date
  updated_at: Date
  /** Patron saint day of the company, for the working days. */
  patron: string | null
}

const HOURS = /^\d{1,2}(\.\d{1,2})?$/

// Dates leave the database as text: a JavaScript Date would shift them with the time zone.
const columns = (t = '') => `${t}id, ${t}employee_id, ${t}kind,
  ${t}starts_on::text as starts_on, ${t}ends_on::text as ends_on, ${t}hours::text as hours,
  ${t}notes, (${t}ends_on - ${t}starts_on + 1)::int as days, ${t}version, ${t}created_at,
  ${t}updated_at, (select patron_saint_day from public.company_profiles
    where company_id = app.current_company_id()) as patron`
const COLUMNS = columns()

interface CompanyAbsenceRow extends AbsenceRow {
  first_name: string
  last_name: string
  active: boolean
}

type Params = { company: string; employee?: string; absence?: string }

function toContract(row: AbsenceRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    kind: row.kind,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    hours: row.hours,
    notes: row.notes,
    days: row.days,
    working_days: row.hours === null ? workingDays(row.starts_on, row.ends_on, row.patron) : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: AbsenceRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

export function parseAbsenceInput(
  body: unknown,
): { input: AbsenceInput } | { errors: FieldErrors } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  const raw = body as Record<string, unknown>
  const text = (field: keyof AbsenceInput): string | null => {
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
    return trimmed === '' ? null : trimmed
  }

  const kindValue = text('kind')
  const kind = ABSENCE_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Scegli il tipo di assenza.')

  const date = (field: 'starts_on' | 'ends_on') => {
    const value = text(field)
    if (errors[field]) return null
    if (value === null) add(field, 'Indica la data.')
    else if (!isIsoDate(value)) add(field, 'Data non valida: usa il formato AAAA-MM-GG.')
    else return value
    return null
  }
  const starts_on = date('starts_on')
  const ends_on = date('ends_on')
  if (starts_on && ends_on && ends_on < starts_on) {
    add('ends_on', 'La fine non può essere prima dell’inizio.')
  }

  const hours = text('hours')
  if (hours !== null) {
    if (!HOURS.test(hours) || Number(hours) <= 0 || Number(hours) > 24) {
      add('hours', 'Ore non valide: da 0.01 a 24, con il punto (es. 2.5).')
    } else if (starts_on && ends_on && starts_on !== ends_on) {
      add('hours', 'Le ore si indicano solo per un’assenza di un giorno.')
    }
  }

  const notes = text('notes')
  if (notes !== null && notes.length > 2000) add('notes', 'Al massimo 2000 caratteri.')
  if (kind === 'other' && notes === null && !errors.notes) add('notes', 'Descrivi l’assenza.')

  if (Object.keys(errors).length > 0 || !kind || !starts_on || !ends_on) return { errors }
  return { input: { kind, starts_on, ends_on, hours, notes } }
}

function readFilters(query: Record<string, unknown>, company: boolean) {
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
  const date = (name: string): string | null => {
    const value = single(name)
    if (value === undefined) return null
    if (!isIsoDate(value)) {
      errors[name] = ['Data non valida (AAAA-MM-GG).']
      return null
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
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (from && to && to < from) errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  let employee: string | null = null
  let kind: AbsenceKind | null = null
  let q: string | null = null
  let page = 1
  let perPage = 25
  if (company) {
    page = integer('page', 1)
    perPage = integer('per_page', 25, 100)
    const employeeValue = single('filter[employee]')
    if (employeeValue !== undefined) {
      if (UUID.test(employeeValue)) employee = employeeValue.toLowerCase()
      else errors['filter[employee]'] = ['Identificativo non valido.']
    }
    const kindValue = single('filter[kind]')
    if (kindValue !== undefined) {
      kind = ABSENCE_KINDS.find((k) => k === kindValue) ?? null
      if (!kind) errors['filter[kind]'] = [`Valori ammessi: ${ABSENCE_KINDS.join(', ')}.`]
    }
    const text = single('filter[q]')?.trim()
    if (text !== undefined && text.length > 100) errors['filter[q]'] = ['Al massimo 100 caratteri.']
    else if (text) q = text
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { from, to, employee, kind, q, page, perPage }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.absenceMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

/**
 * The employee in the path, if this company can see it; 404 otherwise. With `lock` the row is
 * locked until the commit, so two writes cannot both pass the overlap check.
 */
export async function visibleEmployee(
  client: PoolClient,
  id: string | undefined,
  lock = false,
): Promise<string> {
  if (!id || !UUID.test(id)) throw notFound()
  const { rowCount } = await client.query(
    `select 1 from public.employees where id = $1${lock ? ' for update' : ''}`,
    [id],
  )
  if (!rowCount) throw notFound()
  return id
}

async function refuseOverlap(
  client: PoolClient,
  employeeId: string,
  input: AbsenceInput,
  exceptId: string | null,
): Promise<void> {
  const { rows } = await client.query<{ starts_on: string; ends_on: string }>(
    `select starts_on::text as starts_on, ends_on::text as ends_on
     from public.employee_absences
     where employee_id = $1 and starts_on <= $3 and ends_on >= $2
       and ($4::uuid is null or id <> $4)
     order by starts_on limit 1`,
    [employeeId, input.starts_on, input.ends_on, exceptId],
  )
  const other = rows[0]
  if (other) {
    throw new ValidationFailed({
      starts_on: [`Si sovrappone a un’altra assenza (dal ${other.starts_on} al ${other.ends_on}).`],
    })
  }
}

async function missingOrStale(client: PoolClient, id: string, employeeId: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.employee_absences where id = $1 and employee_id = $2',
    [id, employeeId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.absenceStale, 'stale_record')
}

const FIELDS = ['kind', 'starts_on', 'ends_on', 'hours', 'notes'] as const

type CompanyFilters = ReturnType<typeof readFilters>

/** Absences of the whole company, newest first, with the employee. */
async function readCompanyAbsences(
  client: PoolClient,
  filters: CompanyFilters,
  limit: number,
  offset: number,
) {
  const where = `($1::date is null or a.ends_on >= $1) and ($2::date is null or a.starts_on <= $2)
    and ($3::uuid is null or a.employee_id = $3) and ($4::text is null or a.kind = $4)
    and ($5::text is null or strpos(lower(e.last_name || ' ' || e.first_name || ' ' ||
      e.first_name || ' ' || e.last_name || ' ' || coalesce(a.notes, '')), lower($5)) > 0)`
  const values = [filters.from, filters.to, filters.employee, filters.kind, filters.q]
  const { rows } = await client.query<CompanyAbsenceRow>(
    `select ${columns('a.')},
       e.first_name, e.last_name, e.active
     from public.employee_absences a
     join public.employees e on e.id = a.employee_id
     where ${where}
     order by a.starts_on desc, lower(e.last_name), lower(e.first_name), a.id
     limit $6 offset $7`,
    [...values, limit, offset],
  )
  const count = await client.query<{ total: number }>(
    `select count(*)::int as total from public.employee_absences a
     join public.employees e on e.id = a.employee_id where ${where}`,
    values,
  )
  return { rows, total: count.rows[0]?.total ?? 0 }
}

function absenceSummary(r: CompanyAbsenceRow): string {
  const hours = r.hours === null ? '' : ` ${italianQuantity(r.hours)} h`
  return `${r.last_name} ${r.first_name} – ${ABSENCE_NAMES[r.kind]}${hours}`
}

function absenceDescription(r: CompanyAbsenceRow): string {
  const lines = [
    `Tipo: ${ABSENCE_NAMES[r.kind]} (${ABSENCE_CODES[r.kind]})`,
    r.starts_on === r.ends_on
      ? `Il ${italianDate(r.starts_on)}`
      : `Dal ${italianDate(r.starts_on)} al ${italianDate(r.ends_on)}`,
    r.hours === null
      ? `Giorni: ${r.days} (lavorativi ${workingDays(r.starts_on, r.ends_on, r.patron)})`
      : `Ore: ${italianQuantity(r.hours)}`,
  ]
  if (r.notes) lines.push('', r.notes)
  return lines.join('\n')
}

export function employeeAbsenceRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/employees/:employee/absences'

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/absences',
    async (request) => {
      const session = requireSession(request)
      const filters = readFilters(request.query, true)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('employees.view')) throw forbidden()
        const { rows, total } = await readCompanyAbsences(
          client,
          filters,
          filters.perPage,
          (filters.page - 1) * filters.perPage,
        )
        return {
          data: rows.map((r) => ({
            ...toContract(r),
            employee: {
              id: r.employee_id,
              first_name: r.first_name,
              last_name: r.last_name,
              active: r.active,
            },
          })),
          meta: { total, page: filters.page, per_page: filters.perPage },
        }
      })
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/absences/export',
    async (request, reply) => {
      const session = requireSession(request)
      const filters = readFilters(request.query, true)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('employees.view')) throw forbidden()
        const { rows } = await readCompanyAbsences(client, filters, MAX_EXPORT_ROWS, 0)
        return toCsv(
          [
            'Cognome',
            'Nome',
            'Tipo',
            'Sigla',
            'Dal',
            'Al',
            'Giorni',
            'Giorni lavorativi',
            'Ore',
            'Note',
          ],
          rows.map((r) => [
            r.last_name,
            r.first_name,
            ABSENCE_NAMES[r.kind],
            ABSENCE_CODES[r.kind],
            italianDate(r.starts_on),
            italianDate(r.ends_on),
            r.days,
            r.hours === null ? workingDays(r.starts_on, r.ends_on, r.patron) : null,
            r.hours === null ? null : italianQuantity(r.hours),
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="assenze.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/absences/calendar',
    async (request, reply) => {
      const session = requireSession(request)
      const filters = readFilters(request.query, true)
      const ics = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('employees.view')) throw forbidden()
        const { rows } = await readCompanyAbsences(client, filters, MAX_EXPORT_ROWS, 0)
        return toICalendar(
          'Assenze',
          rows.map((r) => ({
            uid: `absence-${r.id}`,
            date: r.starts_on,
            lastDate: r.ends_on,
            summary: absenceSummary(r),
            description: absenceDescription(r),
            stamp: r.updated_at,
            alarm: false,
          })),
          'Assenze',
        )
      })
      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="assenze.ics"')
        .send(ics)
    },
  )

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const { from, to } = readFilters(request.query, false)
      const { rows } = await client.query<AbsenceRow>(
        `select ${COLUMNS} from public.employee_absences
         where employee_id = $1
           and ($2::date is null or ends_on >= $2) and ($3::date is null or starts_on <= $3)
         order by starts_on desc, created_at desc, id desc`,
        [employeeId, from, to],
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
      const employeeId = await visibleEmployee(client, request.params.employee, true)
      const parsed = parseAbsenceInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      await refuseOverlap(client, employeeId, parsed.input, null)
      const { rows } = await client.query<AbsenceRow>(
        `insert into public.employee_absences (company_id, employee_id, ${FIELDS.join(', ')})
         values (app.current_company_id(), $1, $2, $3, $4, $5, $6)
         returning ${COLUMNS}`,
        [employeeId, ...FIELDS.map((f) => parsed.input[f])],
      )
      return rows[0]
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:absence`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee, true)
      const id = request.params.absence ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseAbsenceInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      await refuseOverlap(client, employeeId, parsed.input, id)
      const { rows } = await client.query<AbsenceRow>(
        `update public.employee_absences
         set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             version = version + 1, updated_at = now()
         where id = $6 and employee_id = $7 and version = $8
         returning ${COLUMNS}`,
        [...FIELDS.map((f) => parsed.input[f]), id, employeeId, version],
      )
      return rows[0] ?? missingOrStale(client, id, employeeId)
    })
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:absence`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const id = request.params.absence ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.employee_absences where id = $1 and employee_id = $2 and version = $3',
        [id, employeeId, version],
      )
      if (!rowCount) await missingOrStale(client, id, employeeId)
    })
    return reply.code(204).send()
  })
}
