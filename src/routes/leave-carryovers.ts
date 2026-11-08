import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed, forbidden, notFound, type FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { visibleEmployee } from './employee-absences.js'

interface CarryoverRow {
  year: number
  days: number
  updated_at: Date
}

type Params = { company: string; employee: string; year?: string }

const COLUMNS = 'year::int as year, days::int as days, updated_at'

/** The year of the path: out of range, the address does not exist. */
function pathYear(value: string | undefined): number {
  const year = value !== undefined && /^\d{4}$/.test(value) ? Number(value) : NaN
  if (!(year >= 2000 && year <= 2100)) throw notFound()
  return year
}

export function parseCarryoverInput(body: unknown): { days: number } | { errors: FieldErrors } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const errors: FieldErrors = {}
  const raw = body as Record<string, unknown>
  for (const field of Object.keys(raw)) {
    if (field !== 'days') errors[field] = ['Campo non previsto.']
  }
  const days = raw.days
  if (!('days' in raw)) errors.days = ['Campo mancante.']
  else if (typeof days !== 'number' || !Number.isInteger(days) || days < -366 || days > 366) {
    errors.days = ['Un numero intero di giorni da -366 a 366.']
  }
  if (Object.keys(errors).length > 0) return { errors }
  return { days: days as number }
}

export function leaveCarryoverRoutes(app: FastifyInstance, config: Config, db: Db): void {
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
      const { rows } = await client.query<CarryoverRow>(
        `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
         values (app.current_company_id(), $1, $2, $3)
         on conflict (employee_id, year) do update set days = excluded.days, updated_at = now()
         returning ${COLUMNS}`,
        [employeeId, year, parsed.days],
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
