import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isUniqueViolation, withIdentity } from '../db.js'
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

export const REPORT_STATUSES = ['draft', 'submitted', 'approved'] as const
type Status = (typeof REPORT_STATUSES)[number]

const HOURS = /^\d{1,2}(\.\d{1,2})?$/
const MAX_ROWS = 100

interface HoursInput {
  id: string
  hours: string
  description: string | null
}

interface ReportInput {
  site_id: string
  date: string
  weather: string | null
  work_done: string | null
  notes: string | null
  labor: HoursInput[]
  vehicles: HoursInput[]
}

interface ReportRow {
  id: string
  site_id: string
  site_name: string
  site_code: string | null
  report_date: string
  status: Status
  weather: string | null
  work_done: string | null
  notes: string | null
  created_by: string | null
  created_by_name: string | null
  submitted_at: Date | null
  approved_at: Date | null
  approved_by: string | null
  approved_by_name: string | null
  labor_hours: string
  vehicle_hours: string
  version: number
  created_at: Date
  updated_at: Date
}

interface LaborRow {
  employee_id: string
  first_name: string
  last_name: string
  hours: string
  description: string | null
}

interface VehicleRow {
  vehicle_id: string
  name: string
  plate: string | null
  hours: string
  description: string | null
}

type Params = { company: string; report?: string }

const SELECT = `select r.id, r.site_id, s.name as site_name, s.code as site_code,
    r.report_date::text as report_date, r.status, r.weather, r.work_done, r.notes,
    r.created_by, cu.name as created_by_name, r.submitted_at, r.approved_at, r.approved_by,
    au.name as approved_by_name,
    coalesce((select sum(l.hours) from public.daily_report_labor l where l.report_id = r.id),
      0)::numeric(6, 2)::text as labor_hours,
    coalesce((select sum(v.hours) from public.daily_report_vehicles v where v.report_id = r.id),
      0)::numeric(6, 2)::text as vehicle_hours,
    r.version, r.created_at, r.updated_at
  from public.daily_reports r
  join public.sites s on s.id = r.site_id
  left join lateral app.audit_users(array[r.created_by]) cu on true
  left join lateral app.audit_users(array[r.approved_by]) au on true`

const SORTS = {
  date: 'r.report_date asc, s.name asc, r.id asc',
  '-date': 'r.report_date desc, s.name asc, r.id asc',
  updated_at: 'r.updated_at asc, r.id asc',
  '-updated_at': 'r.updated_at desc, r.id desc',
} as const

function summary(row: ReportRow) {
  return {
    id: row.id,
    site_id: row.site_id,
    site: { id: row.site_id, name: row.site_name, code: row.site_code },
    date: row.report_date,
    status: row.status,
    weather: row.weather,
    work_done: row.work_done,
    notes: row.notes,
    total_labor_hours: row.labor_hours,
    total_vehicle_hours: row.vehicle_hours,
    created_by: row.created_by ? { id: row.created_by, name: row.created_by_name ?? '' } : null,
    submitted_at: row.submitted_at?.toISOString() ?? null,
    approved_at: row.approved_at?.toISOString() ?? null,
    approved_by: row.approved_by ? { id: row.approved_by, name: row.approved_by_name ?? '' } : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

interface FullReport {
  row: ReportRow
  labor: LaborRow[]
  vehicles: VehicleRow[]
}

function toContract({ row, labor, vehicles }: FullReport) {
  return { ...summary(row), labor, vehicles }
}

function send(reply: FastifyReply, report: FullReport, status = 200) {
  return reply.code(status).header('ETag', `"${report.row.version}"`).send(toContract(report))
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.reportMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

export function parseReportInput(body: unknown): ReportInput {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const text = (source: Record<string, unknown>, field: string, path: string, max: number) => {
    if (!(field in source)) {
      add(path, 'Campo mancante.')
      return null
    }
    const value = source[field]
    if (value === null) return null
    if (typeof value !== 'string') {
      add(path, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) add(path, `Al massimo ${max} caratteri.`)
    return trimmed === '' ? null : trimmed
  }
  const site_id = text(raw, 'site_id', 'site_id', 36)
  if (site_id === null && !errors.site_id) add('site_id', 'Scegli il cantiere.')
  else if (site_id !== null && !UUID.test(site_id)) add('site_id', 'Cantiere non trovato.')
  const date = text(raw, 'date', 'date', 10)
  if (date === null && !errors.date) add('date', 'Indica il giorno.')
  else if (date !== null && !errors.date && !isIsoDate(date)) {
    add('date', 'Data non valida (AAAA-MM-GG).')
  }
  const weather = text(raw, 'weather', 'weather', 100)
  const work_done = text(raw, 'work_done', 'work_done', 5000)
  const notes = text(raw, 'notes', 'notes', 2000)

  const rows = (field: 'labor' | 'vehicles', idField: string, missing: string) => {
    const value = raw[field]
    if (!Array.isArray(value)) {
      add(field, field in raw ? 'Deve essere un elenco.' : 'Campo mancante.')
      return []
    }
    if (value.length > MAX_ROWS) {
      add(field, `Al massimo ${MAX_ROWS} righe.`)
      return []
    }
    const seen = new Set<string>()
    return value.map((item: unknown, index): HoursInput => {
      const path = `${field}.${index}`
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        add(path, 'Ogni riga deve essere un oggetto.')
        return { id: '', hours: '', description: null }
      }
      const entry = item as Record<string, unknown>
      const id = text(entry, idField, `${path}.${idField}`, 36) ?? ''
      if (!id && !errors[`${path}.${idField}`]) add(`${path}.${idField}`, missing)
      else if (id && !UUID.test(id)) add(`${path}.${idField}`, 'Non trovato.')
      else if (id && seen.has(id.toLowerCase())) add(`${path}.${idField}`, 'Già presente.')
      seen.add(id.toLowerCase())
      const hours = text(entry, 'hours', `${path}.hours`, 5) ?? ''
      if (!errors[`${path}.hours`]) {
        if (!HOURS.test(hours) || Number(hours) <= 0 || Number(hours) > 24) {
          add(`${path}.hours`, 'Ore non valide: da 0.01 a 24, con il punto (es. 7.5).')
        }
      }
      const description = text(entry, 'description', `${path}.description`, 500)
      return { id: id.toLowerCase(), hours, description }
    })
  }
  const labor = rows('labor', 'employee_id', 'Scegli il dipendente.')
  const vehicles = rows('vehicles', 'vehicle_id', 'Scegli il mezzo.')
  if (Object.keys(errors).length > 0 || !site_id || !date) throw new ValidationFailed(errors)
  return {
    site_id: site_id.toLowerCase(),
    date,
    weather,
    work_done,
    notes,
    labor,
    vehicles,
  }
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
  const date = (name: string) => {
    const value = single(name)
    if (value !== undefined && !isIsoDate(value)) {
      errors[name] = ['Data non valida (AAAA-MM-GG).']
      return undefined
    }
    return value
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const sortValue = single('sort') ?? '-date'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const statusValue = single('filter[status]')
  const status = REPORT_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const siteId = single('filter[site]')
  if (siteId !== undefined && !UUID.test(siteId)) {
    errors['filter[site]'] = ['Identificativo non valido.']
  }
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (from && to && to < from) errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-date', status, siteId, from, to }
}

async function readOne(client: PoolClient, id: string): Promise<FullReport | undefined> {
  const { rows } = await client.query<ReportRow>(`${SELECT} where r.id = $1`, [id])
  const row = rows[0]
  if (!row) return undefined
  const labor = await client.query<LaborRow>(
    `select l.employee_id, e.first_name, e.last_name, l.hours::text as hours, l.description
     from public.daily_report_labor l join public.employees e on e.id = l.employee_id
     where l.report_id = $1 order by l.position`,
    [id],
  )
  const vehicles = await client.query<VehicleRow>(
    `select v.vehicle_id, m.name, m.plate, v.hours::text as hours, v.description
     from public.daily_report_vehicles v join public.vehicles m on m.id = v.vehicle_id
     where v.report_id = $1 order by v.position`,
    [id],
  )
  return { row, labor: labor.rows, vehicles: vehicles.rows }
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.reportStale, 'stale_record')
}

/** Site, employees and vehicles must belong to the company: errors under the right field. */
async function checkReferences(client: PoolClient, input: ReportInput) {
  const errors: FieldErrors = {}
  const site = await client.query('select 1 from public.sites where id = $1', [input.site_id])
  if (!site.rowCount) errors.site_id = ['Cantiere non trovato.']
  const check = async (table: string, field: string, rows: HoursInput[], idField: string) => {
    if (rows.length === 0) return
    const { rows: found } = await client.query<{ id: string }>(
      `select id::text as id from public.${table} where id = any($1::uuid[])`,
      [rows.map((r) => r.id)],
    )
    const known = new Set(found.map((r) => r.id))
    rows.forEach((r, i) => {
      if (!known.has(r.id)) errors[`${field}.${i}.${idField}`] = ['Non trovato.']
    })
  }
  await check('employees', 'labor', input.labor, 'employee_id')
  await check('vehicles', 'vehicles', input.vehicles, 'vehicle_id')
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
}

async function writeHours(client: PoolClient, id: string, input: ReportInput) {
  await client.query('delete from public.daily_report_labor where report_id = $1', [id])
  await client.query('delete from public.daily_report_vehicles where report_id = $1', [id])
  const insert = async (table: string, column: string, rows: HoursInput[]) => {
    if (rows.length === 0) return
    await client.query(
      `insert into public.${table} (company_id, report_id, ${column}, hours, description, position)
       select app.current_company_id(), $1, x.id, x.hours, x.description, x.position
       from unnest($2::uuid[], $3::numeric[], $4::text[], $5::int[])
         as x(id, hours, description, position)`,
      [
        id,
        rows.map((r) => r.id),
        rows.map((r) => r.hours),
        rows.map((r) => r.description),
        rows.map((_, i) => i),
      ],
    )
  }
  await insert('daily_report_labor', 'employee_id', input.labor)
  await insert('daily_report_vehicles', 'vehicle_id', input.vehicles)
}

function duplicateDay(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({
      date: ['Esiste già un rapportino per questo cantiere in questo giorno.'],
    })
  }
  throw error
}

export function dailyReportRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/daily-reports'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.view')) throw forbidden()
      const where = ['true']
      const values: unknown[] = []
      const add = (sql: (p: string) => string, value: unknown) => {
        values.push(value)
        where.push(sql(`$${values.length}`))
      }
      if (list.status) add((p) => `r.status = ${p}`, list.status)
      if (list.siteId) add((p) => `r.site_id = ${p}`, list.siteId)
      if (list.from) add((p) => `r.report_date >= ${p}`, list.from)
      if (list.to) add((p) => `r.report_date <= ${p}`, list.to)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<ReportRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.daily_reports r where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(summary),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
      }
    })
  })

  app.get<{ Params: Params }>(`${base}/:report`, async (request, reply) => {
    const session = requireSession(request)
    const report = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.view')) throw notFound()
      const id = request.params.report ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!report) throw notFound()
    return send(reply, report)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const report = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.create')) throw forbidden()
      const input = parseReportInput(request.body)
      await checkReferences(client, input)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.daily_reports
             (company_id, site_id, report_date, weather, work_done, notes, created_by)
           values (app.current_company_id(), $1, $2, $3, $4, $5, $6)
           returning id`,
          [input.site_id, input.date, input.weather, input.work_done, input.notes, session.user.id],
        )
        .catch(duplicateDay)
      const id = rows[0]?.id ?? ''
      await writeHours(client, id, input)
      return readOne(client, id)
    })
    if (!report) throw new Error('insert returned no row')
    return send(reply, report, 201)
  })

  app.put<{ Params: Params }>(`${base}/:report`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const report = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.update')) throw forbidden()
      const id = request.params.report ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseReportInput(request.body)
      const current = await readOne(client, id)
      if (!current) throw notFound()
      if (current.row.version !== version)
        throw new ApiError(412, messages.reportStale, 'stale_record')
      if (current.row.status !== 'draft') {
        throw new ApiError(409, messages.reportNotDraft, 'report_not_draft')
      }
      await checkReferences(client, input)
      const { rowCount } = await client
        .query(
          `update public.daily_reports
           set site_id = $1, report_date = $2, weather = $3, work_done = $4, notes = $5,
               version = version + 1, updated_at = now()
           where id = $6 and version = $7 and status = 'draft'`,
          [input.site_id, input.date, input.weather, input.work_done, input.notes, id, version],
        )
        .catch(duplicateDay)
      if (!rowCount) return missingOrStale(client, id)
      await writeHours(client, id, input)
      return readOne(client, id)
    })
    if (!report) throw notFound()
    return send(reply, report)
  })

  app.post<{ Params: Params }>(`${base}/:report/status`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const report = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.update') && !permissions.has('reports.approve')) {
        throw forbidden()
      }
      const id = request.params.report ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const body = request.body as Record<string, unknown> | null
      const target = REPORT_STATUSES.find((s) => s === body?.status)
      if (!target) throw new ValidationFailed({ status: ['Stato non valido.'] })
      const current = await readOne(client, id)
      if (!current) throw notFound()
      const from = current.row.status
      // Submitting is part of writing the report; approving and sending back are not.
      const needed =
        from === 'draft' && target === 'submitted' ? 'reports.update' : 'reports.approve'
      if (!permissions.has(needed)) throw forbidden()
      if (current.row.version !== version)
        throw new ApiError(412, messages.reportStale, 'stale_record')
      const allowed =
        (from === 'draft' && target === 'submitted') ||
        (from === 'submitted' && target === 'approved') ||
        (from !== 'draft' && target === 'draft')
      if (!allowed) {
        throw new ApiError(409, messages.reportInvalidTransition, 'invalid_transition')
      }
      const { rowCount } = await client.query(
        `update public.daily_reports
         set status = $1,
             submitted_at = case when $1 = 'draft' then null
                                 when $1 = 'submitted' then now() else submitted_at end,
             approved_at = case when $1 = 'approved' then now() else null end,
             approved_by = case when $1 = 'approved' then $2::uuid else null end,
             version = version + 1, updated_at = now()
         where id = $3 and version = $4`,
        [target, session.user.id, id, version],
      )
      if (!rowCount) return missingOrStale(client, id)
      return readOne(client, id)
    })
    if (!report) throw notFound()
    return send(reply, report)
  })

  app.delete<{ Params: Params }>(`${base}/:report`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.delete')) throw forbidden()
      const id = request.params.report ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        "delete from public.daily_reports where id = $1 and version = $2 and status = 'draft'",
        [id, version],
      )
      if (rowCount) return
      const current = await readOne(client, id)
      if (current && current.row.version === version) {
        throw new ApiError(409, messages.reportNotDraft, 'report_not_draft')
      }
      await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
