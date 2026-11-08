import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed, forbidden, notFound, type FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { visibleEmployee } from './employee-absences.js'
import { readTotals } from './absence-totals.js'

interface CarryoverRow {
  year: number
  days: number | null
  permit_hours: string | null
  updated_at: Date
}

/** The parts of a carry-over in a PUT: a missing one stays as it is, null removes it. */
interface CarryoverInput {
  days?: number | null
  permit_hours?: string | null
}

type Params = { company: string; employee: string; year?: string }

const COLUMNS =
  'year::int as year, days::int as days, permit_hours::numeric(10, 2)::text as permit_hours, updated_at'

const PERMIT_HOURS = /^-?\d{1,4}(\.\d{1,2})?$/

/** The year of the path: out of range, the address does not exist. */
function pathYear(value: string | undefined): number {
  const year = value !== undefined && /^\d{4}$/.test(value) ? Number(value) : NaN
  if (!(year >= 2000 && year <= 2100)) throw notFound()
  return year
}

export function parseCarryoverInput(body: unknown): CarryoverInput | { errors: FieldErrors } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const errors: FieldErrors = {}
  const raw = body as Record<string, unknown>
  for (const field of Object.keys(raw)) {
    if (field !== 'days' && field !== 'permit_hours') errors[field] = ['Campo non previsto.']
  }
  const input: CarryoverInput = {}
  if ('days' in raw) {
    const days = raw.days
    if (
      days !== null &&
      (typeof days !== 'number' || !Number.isInteger(days) || days < -366 || days > 366)
    ) {
      errors.days = ['Un numero intero di giorni da -366 a 366, o null.']
    } else input.days = days
  }
  if ('permit_hours' in raw) {
    const hours = raw.permit_hours
    if (
      hours !== null &&
      (typeof hours !== 'string' || !PERMIT_HOURS.test(hours) || Math.abs(Number(hours)) > 2000)
    ) {
      errors.permit_hours = ['Ore da -2000 a 2000, con il punto e al massimo due decimali, o null.']
    } else input.permit_hours = hours
  }
  if (!('days' in raw) && !('permit_hours' in raw) && Object.keys(errors).length === 0) {
    errors._ = ['Indica i giorni di ferie, le ore di permesso o entrambi.']
  }
  if (Object.keys(errors).length > 0) return { errors }
  return input
}

/** The year to close, from the body: the carry-overs go into the year after, up to 2100. */
function closingYear(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const errors: FieldErrors = {}
  const raw = body as Record<string, unknown>
  for (const field of Object.keys(raw)) {
    if (field !== 'year') errors[field] = ['Campo non previsto.']
  }
  const year = raw.year
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 2099) {
    errors.year = ['Un anno da 2000 a 2099.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return year as number
}

export function leaveCarryoverRoutes(app: FastifyInstance, config: Config, db: Db): void {
  /**
   * Closing of the year: the remaining vacation and leave hours of every active employee
   * become the carry-over into the year after. Only the parts with an allowance are written;
   * the others stay as they are. Running it again recomputes the same values.
   */
  app.post<{ Params: { company: string } }>(
    '/api/companies/:company/absences/close-year',
    async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('employees.update')) throw forbidden()
        const year = closingYear(request.body)
        const totals = await readTotals(client, { year: String(year) })
        const closing = totals.employees.filter(
          (e) =>
            e.employee.active && (e.vacation_remaining !== null || e.permit_remaining !== null),
        )
        const errors: string[] = []
        for (const e of closing) {
          const name = `${e.employee.last_name} ${e.employee.first_name}`
          if (e.vacation_remaining !== null && Math.abs(e.vacation_remaining) > 366) {
            errors.push(`${name}: ferie residue fuori dall'intervallo da -366 a 366.`)
          }
          if (e.permit_remaining !== null && Math.abs(Number(e.permit_remaining)) > 2000) {
            errors.push(`${name}: ore di permesso residue fuori dall'intervallo da -2000 a 2000.`)
          }
        }
        if (errors.length > 0) throw new ValidationFailed({ _: errors })
        const data = []
        for (const e of closing) {
          const { rows } = await client.query<{ days: number | null; permit_hours: string | null }>(
            `insert into public.employee_leave_carryovers
               (company_id, employee_id, year, days, permit_hours)
             values (app.current_company_id(), $1, $2, $3, $4::numeric)
             on conflict (employee_id, year) do update set
               days = coalesce($3, employee_leave_carryovers.days),
               permit_hours = coalesce($4::numeric, employee_leave_carryovers.permit_hours),
               updated_at = now()
             returning days::int as days, permit_hours::numeric(10, 2)::text as permit_hours`,
            [e.employee.id, year + 1, e.vacation_remaining, e.permit_remaining],
          )
          data.push({
            employee: {
              id: e.employee.id,
              first_name: e.employee.first_name,
              last_name: e.employee.last_name,
            },
            days: rows[0]?.days ?? null,
            permit_hours: rows[0]?.permit_hours ?? null,
          })
        }
        return { year, carried_into: year + 1, data }
      })
    },
  )

  const base = '/api/companies/:company/employees/:employee/leave-carryovers'

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const { rows } = await client.query<CarryoverRow>(
        `select ${COLUMNS} from public.employee_leave_carryovers
         where employee_id = $1 order by year desc`,
        [employeeId],
      )
      return { data: rows }
    })
  })

  app.put<{ Params: Params }>(`${base}/:year`, async (request) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee, true)
      const year = pathYear(request.params.year)
      const parsed = parseCarryoverInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const current = await client.query<{ days: number | null; permit_hours: string | null }>(
        `select days::int as days, permit_hours::text as permit_hours
         from public.employee_leave_carryovers where employee_id = $1 and year = $2 for update`,
        [employeeId, year],
      )
      const days = parsed.days === undefined ? (current.rows[0]?.days ?? null) : parsed.days
      const hours =
        parsed.permit_hours === undefined
          ? (current.rows[0]?.permit_hours ?? null)
          : parsed.permit_hours
      if (days === null && hours === null) {
        throw new ValidationFailed({
          _: ['Senza giorni e senza ore il riporto non resta: per toglierlo si elimina.'],
        })
      }
      const { rows } = await client.query<CarryoverRow>(
        `insert into public.employee_leave_carryovers
           (company_id, employee_id, year, days, permit_hours)
         values (app.current_company_id(), $1, $2, $3, $4)
         on conflict (employee_id, year) do update
           set days = excluded.days, permit_hours = excluded.permit_hours, updated_at = now()
         returning ${COLUMNS}`,
        [employeeId, year, days, hours],
      )
      return rows[0]
    })
  })

  app.delete<{ Params: Params }>(`${base}/:year`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.update')) throw forbidden()
      const employeeId = await visibleEmployee(client, request.params.employee)
      const year = pathYear(request.params.year)
      const { rowCount } = await client.query(
        'delete from public.employee_leave_carryovers where employee_id = $1 and year = $2',
        [employeeId, year],
      )
      if (!rowCount) throw notFound()
    })
    return reply.code(204).send()
  })
}
