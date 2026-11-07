import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { centsToAmount } from '../money.js'
import { ValidationFailed, forbidden, notFound, type FieldErrors } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import type { Permission } from '../permissions.js'

const STATUSES = ['draft', 'submitted', 'approved'] as const

interface Filters {
  from: string | undefined
  to: string | undefined
  status: (typeof STATUSES)[number] | undefined
}

function readFilters(query: Record<string, unknown>): Filters {
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
  const date = (name: string) => {
    const value = single(name)
    if (value !== undefined && !isIsoDate(value)) {
      errors[name] = ['Data non valida (AAAA-MM-GG).']
      return undefined
    }
    return value
  }
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (from && to && to < from) errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  const statusValue = single('filter[status]')
  const status = STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { from, to, status }
}

interface Source {
  /** Table of the resource (employees or vehicles). */
  table: 'employees' | 'vehicles'
  /** Table of its hours in the daily reports, and the column pointing to it. */
  hours: 'daily_report_labor' | 'daily_report_vehicles'
  column: 'employee_id' | 'vehicle_id'
}

interface SiteRow {
  id: string
  name: string
  code: string | null
  hours: string
  days: number
  cents: string | null
  first_date: string
  last_date: string
}

/** Hours of one employee or vehicle per site, in the shape of WorkSummary; null if not found. */
async function readSummary(
  client: PoolClient,
  source: Source,
  id: string,
  query: Record<string, unknown>,
  canSeeReports: boolean,
) {
  const owner = await client.query<{ cents: string | null }>(
    `select hourly_cost_cents::text as cents from public.${source.table} where id = $1`,
    [id],
  )
  const resource = owner.rows[0]
  if (!resource) return null
  if (!canSeeReports) throw forbidden()
  const filters = readFilters(query)
  const values: unknown[] = [id]
  const where = [`h.${source.column} = $1`]
  if (filters.from) {
    values.push(filters.from)
    where.push(`r.report_date >= $${values.length}::date`)
  }
  if (filters.to) {
    values.push(filters.to)
    where.push(`r.report_date <= $${values.length}::date`)
  }
  if (filters.status) {
    values.push(filters.status)
    where.push(`r.status = $${values.length}`)
  }
  const cents = resource.cents
  values.push(cents)
  const rate = `$${values.length}::bigint`
  const from = `from public.${source.hours} h
     join public.daily_reports r on r.id = h.report_id`
  const sites = await client.query<SiteRow>(
    `select s.id, s.name, s.code,
       sum(h.hours)::numeric(10, 2)::text as hours,
       count(distinct r.report_date)::int as days,
       sum(round(h.hours * ${rate}))::bigint::text as cents,
       min(r.report_date)::text as first_date,
       max(r.report_date)::text as last_date
     ${from}
     join public.sites s on s.id = r.site_id
     where ${where.join(' and ')}
     group by s.id
     order by sum(h.hours) desc, lower(s.name), s.id`,
    values,
  )
  const total = await client.query<{ hours: string; days: number; cents: string | null }>(
    `select coalesce(sum(h.hours), 0)::numeric(10, 2)::text as hours,
       count(distinct r.report_date)::int as days,
       coalesce(sum(round(h.hours * ${rate})), 0)::bigint::text as cents
     ${from}
     where ${where.join(' and ')}`,
    values,
  )
  const sum = total.rows[0] ?? { hours: '0.00', days: 0, cents: null }
  const cost = (c: string | null) => (cents === null || c === null ? null : centsToAmount(c))
  return {
    hours: sum.hours,
    days: sum.days,
    cost: cost(sum.cents),
    sites: sites.rows.map((r) => ({
      site: { id: r.id, name: r.name, code: r.code },
      hours: r.hours,
      days: r.days,
      cost: cost(r.cents),
      first_date: r.first_date,
      last_date: r.last_date,
    })),
  }
}

/** Hours of an employee or a vehicle per site, for their cards. */
export function workSummaryRoutes(app: FastifyInstance, db: Db): void {
  const routes: { path: string; param: string; permission: Permission; source: Source }[] = [
    {
      path: '/api/companies/:company/employees/:employee/work-summary',
      param: 'employee',
      permission: 'employees.view',
      source: { table: 'employees', hours: 'daily_report_labor', column: 'employee_id' },
    },
    {
      path: '/api/companies/:company/vehicles/:vehicle/work-summary',
      param: 'vehicle',
      permission: 'vehicles.view',
      source: { table: 'vehicles', hours: 'daily_report_vehicles', column: 'vehicle_id' },
    },
  ]
  for (const route of routes) {
    app.get<{ Params: Record<string, string>; Querystring: Record<string, unknown> }>(
      route.path,
      async (request, reply) => {
        const session = requireSession(request)
        const summary = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company ?? '')
          if (!permissions.has(route.permission)) throw notFound()
          const id = request.params[route.param] ?? ''
          if (!UUID.test(id)) throw notFound()
          return readSummary(
            client,
            route.source,
            id.toLowerCase(),
            request.query,
            permissions.has('reports.view'),
          )
        })
        if (!summary) throw notFound()
        return reply.send(summary)
      },
    )
  }
}
