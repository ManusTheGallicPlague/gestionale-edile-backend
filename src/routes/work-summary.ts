import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { centsToAmount } from '../money.js'
import { italianDate, toCsv } from '../csv.js'
import { ValidationFailed, forbidden, notFound, type FieldErrors } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import type { Permission } from '../permissions.js'
import { ABSENCE_KINDS } from './employee-absences.js'

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

interface ResourceRow {
  id: string
  hours: string
  days: number
  cents: string | null
  first_date: string
  last_date: string
}

/** Hours of a site per employee and per vehicle, as SiteWorkSummary; null if not found. */
async function readSiteSummary(
  client: PoolClient,
  siteId: string,
  query: Record<string, unknown>,
  canSeeReports: boolean,
  canSeeCosts: boolean,
) {
  const site = await client.query('select 1 from public.sites where id = $1', [siteId])
  if (site.rowCount === 0) return null
  if (!canSeeReports) throw forbidden()
  const filters = readFilters(query)
  const values: unknown[] = [siteId]
  const where = ['r.site_id = $1']
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
  const cost = (c: string | null) => (!canSeeCosts || c === null ? null : centsToAmount(c))
  const part = async <T extends ResourceRow>(
    hours: Source['hours'],
    column: Source['column'],
    table: Source['table'],
    fields: string,
    order: string,
  ) => {
    const { rows } = await client.query<T>(
      `select x.id, ${fields},
         sum(h.hours)::numeric(10, 2)::text as hours,
         count(distinct r.report_date)::int as days,
         sum(round(h.hours * x.hourly_cost_cents))::bigint::text as cents,
         min(r.report_date)::text as first_date,
         max(r.report_date)::text as last_date
       from public.${hours} h
       join public.daily_reports r on r.id = h.report_id
       join public.${table} x on x.id = h.${column}
       where ${where.join(' and ')}
       group by x.id
       order by sum(h.hours) desc, ${order}, x.id`,
      values,
    )
    // Hours have two decimals: sum them as hundredths, like cents.
    let hundredths = 0n
    let cents = 0n
    for (const r of rows) {
      hundredths += BigInt(r.hours.replace('.', ''))
      cents += BigInt(r.cents ?? '0')
    }
    return { rows, hours: centsToAmount(hundredths.toString()), cost: cost(cents.toString()) }
  }
  const labor = await part<ResourceRow & { first_name: string; last_name: string }>(
    'daily_report_labor',
    'employee_id',
    'employees',
    'x.first_name, x.last_name',
    'lower(x.last_name), lower(x.first_name)',
  )
  const vehicles = await part<ResourceRow & { name: string; plate: string | null }>(
    'daily_report_vehicles',
    'vehicle_id',
    'vehicles',
    'x.name, x.plate',
    'lower(x.name)',
  )
  const common = (r: ResourceRow) => ({
    hours: r.hours,
    days: r.days,
    cost: cost(r.cents),
    first_date: r.first_date,
    last_date: r.last_date,
  })
  return {
    labor: {
      hours: labor.hours,
      cost: labor.cost,
      rows: labor.rows.map((r) => ({
        employee: { id: r.id, first_name: r.first_name, last_name: r.last_name },
        ...common(r),
      })),
    },
    vehicles: {
      hours: vehicles.hours,
      cost: vehicles.cost,
      rows: vehicles.rows.map((r) => ({
        vehicle: { id: r.id, name: r.name, plate: r.plate },
        ...common(r),
      })),
    },
  }
}

/**
 * Absences of an employee in the period of the summary, per kind: calendar days of the
 * whole-day absences, clipped to the period, and hours of the leaves.
 */
async function readAbsences(client: PoolClient, id: string, query: Record<string, unknown>) {
  const { from, to } = readFilters(query)
  const { rows } = await client.query<{ kind: string; days: number; hours: string }>(
    `select kind,
       coalesce(sum(least(ends_on, coalesce($3::date, ends_on))
         - greatest(starts_on, coalesce($2::date, starts_on)) + 1)
         filter (where hours is null), 0)::int as days,
       coalesce(sum(hours), 0)::numeric(10, 2)::text as hours
     from public.employee_absences
     where employee_id = $1
       and ($2::date is null or ends_on >= $2) and ($3::date is null or starts_on <= $3)
     group by kind`,
    [id, from ?? null, to ?? null],
  )
  const kinds = ABSENCE_KINDS.flatMap((kind) => rows.filter((r) => r.kind === kind))
  // Hours have two decimals: sum them as hundredths, like cents.
  const hundredths = kinds.reduce((sum, r) => sum + BigInt(r.hours.replace('.', '')), 0n)
  return {
    days: kinds.reduce((sum, r) => sum + r.days, 0),
    hours: centsToAmount(hundredths.toString()),
    kinds: kinds.map((r) => ({ kind: r.kind, days: r.days, hours: r.hours })),
  }
}

/** Maintenance of a vehicle in the period of the summary: how many jobs and their cost. */
async function readMaintenance(client: PoolClient, id: string, query: Record<string, unknown>) {
  const { from, to } = readFilters(query)
  const { rows } = await client.query<{ count: number; cents: string }>(
    `select count(*)::int as count, coalesce(sum(amount_cents), 0)::text as cents
     from public.vehicle_maintenances
     where vehicle_id = $1
       and ($2::date is null or performed_on >= $2) and ($3::date is null or performed_on <= $3)`,
    [id, from ?? null, to ?? null],
  )
  return { count: rows[0]?.count ?? 0, amount: centsToAmount(rows[0]?.cents ?? '0') }
}

/** Refuelings of a vehicle in the period of the summary: how many, litres and cost. */
async function readFuel(client: PoolClient, id: string, query: Record<string, unknown>) {
  const { from, to } = readFilters(query)
  // Summed in the database: litres and cents never pass through a float.
  const { rows } = await client.query<{ count: number; liters: string; cents: string }>(
    `select count(*)::int as count, coalesce(sum(liters), 0)::numeric(14, 2)::text as liters,
       coalesce(sum(amount_cents), 0)::text as cents
     from public.vehicle_refuelings
     where vehicle_id = $1
       and ($2::date is null or refueled_on >= $2) and ($3::date is null or refueled_on <= $3)`,
    [id, from ?? null, to ?? null],
  )
  // Full to full: the refueling with the lowest reading only marks the start; the litres of
  // the others were burnt over the distance. Per 100 km for road vehicles, per hour otherwise.
  const { rows: meter } = await client.query<{
    distance: number | null
    consumption: string | null
  }>(
    `with r as (
       select liters, meter_reading,
         row_number() over (order by meter_reading, refueled_on, created_at, id) as n
       from public.vehicle_refuelings
       where vehicle_id = $1 and meter_reading is not null
         and ($2::date is null or refueled_on >= $2) and ($3::date is null or refueled_on <= $3)
     ), t as (
       select case when count(*) >= 2 then max(meter_reading) - min(meter_reading) end
           as distance,
         coalesce(sum(liters) filter (where n > 1), 0) as burnt
       from r
     )
     select t.distance,
       case when t.distance > 0 then
         (t.burnt * case when v.kind = 'vehicle' then 100 else 1 end / t.distance)
           ::numeric(20, 2)::text
       end as consumption
     from t, public.vehicles v
     where v.id = $1`,
    [id, from ?? null, to ?? null],
  )
  return {
    count: rows[0]?.count ?? 0,
    liters: rows[0]?.liters ?? '0.00',
    amount: centsToAmount(rows[0]?.cents ?? '0'),
    meter_distance: meter[0]?.distance ?? null,
    consumption: meter[0]?.consumption ?? null,
  }
}

/** Hours of an employee or a vehicle per site, for their cards. */
export function workSummaryRoutes(app: FastifyInstance, db: Db): void {
  const routes: {
    path: string
    param: string
    permission: Permission
    source: Source
    file: string
  }[] = [
    {
      path: '/api/companies/:company/employees/:employee/work-summary',
      param: 'employee',
      permission: 'employees.view',
      file: 'ore-dipendente.csv',
      source: { table: 'employees', hours: 'daily_report_labor', column: 'employee_id' },
    },
    {
      path: '/api/companies/:company/vehicles/:vehicle/work-summary',
      param: 'vehicle',
      permission: 'vehicles.view',
      file: 'ore-mezzo.csv',
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
          const summary = await readSummary(
            client,
            route.source,
            id.toLowerCase(),
            request.query,
            permissions.has('reports.view'),
          )
          if (!summary) return summary
          if (route.source.table === 'vehicles') {
            return {
              ...summary,
              maintenance: await readMaintenance(client, id.toLowerCase(), request.query),
              fuel: await readFuel(client, id.toLowerCase(), request.query),
            }
          }
          return {
            ...summary,
            absences: await readAbsences(client, id.toLowerCase(), request.query),
          }
        })
        if (!summary) throw notFound()
        return reply.send(summary)
      },
    )

    app.get<{ Params: Record<string, string>; Querystring: Record<string, unknown> }>(
      `${route.path}/export`,
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
        const decimal = (value: string | null) => (value === null ? null : value.replace('.', ','))
        const csv = toCsv(
          ['Codice', 'Cantiere', 'Ore', 'Giorni', 'Costo', 'Primo giorno', 'Ultimo giorno'],
          [
            ...summary.sites.map((r) => [
              r.site.code,
              r.site.name,
              decimal(r.hours),
              r.days,
              decimal(r.cost),
              italianDate(r.first_date),
              italianDate(r.last_date),
            ]),
            [
              null,
              'Totale',
              decimal(summary.hours),
              summary.days,
              decimal(summary.cost),
              null,
              null,
            ],
          ],
        )
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${route.file}"`)
          .send(csv)
      },
    )
  }

  app.get<{ Params: { company: string; site: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/sites/:site/work-summary',
    async (request, reply) => {
      const session = requireSession(request)
      const summary = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('sites.view')) throw notFound()
        if (!UUID.test(request.params.site)) throw notFound()
        return readSiteSummary(
          client,
          request.params.site.toLowerCase(),
          request.query,
          permissions.has('reports.view'),
          permissions.has('costs.view'),
        )
      })
      if (!summary) throw notFound()
      return reply.send(summary)
    },
  )
}
