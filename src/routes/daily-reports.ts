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
import { MAX_EXPORT_ROWS, italianDate, toCsv } from '../csv.js'
import { centsToAmount } from '../money.js'
import { reportPdf, reportsPdf, type ReportPdfData } from '../daily-reports/pdf.js'
import { italianQuantity } from '../quotes/pdf.js'
import { readLogoForPdf } from './logo.js'
import { readProfile } from './settings.js'
import { ABSENCE_CODES, type AbsenceKind } from './employee-absences.js'
import { employeeDocumentsExpiredOn } from './employees.js'
import { vehicleDocumentsExpiredOn } from './vehicles.js'

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

const STATUS_LABELS: Record<Status, string> = {
  draft: 'Bozza',
  submitted: 'Inviato',
  approved: 'Approvato',
}

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
  const id = (name: string) => {
    const value = single(name)
    if (value !== undefined && !UUID.test(value)) errors[name] = ['Identificativo non valido.']
    return value
  }
  const employeeId = id('filter[employee]')
  const vehicleId = id('filter[vehicle]')
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (from && to && to < from) errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-date', status, siteId, employeeId, vehicleId, from, to }
}

function readMonthlyHours(query: Record<string, unknown>) {
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
  const month = single('month')
  if (month === undefined) {
    errors.month ??= ['Indica il mese (AAAA-MM).']
  } else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    errors.month = ['Mese non valido (AAAA-MM).']
  }
  const statusValue = single('filter[status]')
  const status = REPORT_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const siteId = single('filter[site]')
  if (siteId !== undefined && !UUID.test(siteId)) {
    errors['filter[site]'] = ['Identificativo non valido.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { month: month ?? '', status, siteId }
}

const MAX_WORK_LOG = 200

async function pdfCommon(client: PoolClient) {
  const profile = await readProfile(client)
  return {
    logo: await readLogoForPdf(client),
    company: {
      ...profile,
      share_capital:
        profile.share_capital_cents === null ? null : centsToAmount(profile.share_capital_cents),
    },
  }
}

function pdfData(
  common: Awaited<ReturnType<typeof pdfCommon>>,
  { row, labor, vehicles }: FullReport,
  address: string | null,
): ReportPdfData {
  return {
    ...common,
    site: { name: row.site_name, code: row.site_code, address },
    date: row.report_date,
    status: row.status,
    weather: row.weather,
    work_done: row.work_done,
    notes: row.notes,
    created_by: row.created_by ? (row.created_by_name ?? null) : null,
    approved_by: row.approved_by ? (row.approved_by_name ?? null) : null,
    approved_at: row.approved_at,
    total_labor_hours: row.labor_hours,
    total_vehicle_hours: row.vehicle_hours,
    labor,
    vehicles,
  }
}

function sendPdf(reply: FastifyReply, name: string, buffer: Buffer) {
  // Site codes are free text: keep the file name to safe characters.
  const file = `${name.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `attachment; filename="${file}"`)
    .header('Cache-Control', 'private, no-store')
    .send(buffer)
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
  // No hours for someone away the whole day; a leave of a few hours does not block.
  if (input.labor.length > 0 && isIsoDate(input.date)) {
    // The kind of the absence (a sick leave, say) stays out: it needs employees.view.
    const { rows: away } = await client.query<{ employee_id: string }>(
      `select employee_id::text as employee_id from public.employee_absences
       where employee_id = any($1::uuid[]) and hours is null
         and $2::date between starts_on and ends_on`,
      [input.labor.map((r) => r.id), input.date],
    )
    const ids = new Set(away.map((a) => a.employee_id))
    input.labor.forEach((r, i) => {
      if (ids.has(r.id)) {
        errors[`labor.${i}.employee_id`] = ['Il dipendente è assente tutto il giorno.']
      }
    })
  }
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

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.status) add((p) => `r.status = ${p}`, list.status)
  if (list.siteId) add((p) => `r.site_id = ${p}`, list.siteId)
  if (list.employeeId) {
    add(
      (p) =>
        `exists (select 1 from public.daily_report_labor l where l.report_id = r.id and l.employee_id = ${p})`,
      list.employeeId,
    )
  }
  if (list.vehicleId) {
    add(
      (p) =>
        `exists (select 1 from public.daily_report_vehicles v where v.report_id = r.id and v.vehicle_id = ${p})`,
      list.vehicleId,
    )
  }
  if (list.from) add((p) => `r.report_date >= ${p}`, list.from)
  if (list.to) add((p) => `r.report_date <= ${p}`, list.to)
  return { where, values }
}

export function dailyReportRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/daily-reports'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.view')) throw forbidden()
      const { where, values } = listFilter(list)
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

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('reports.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<ReportRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Data',
            'Cantiere',
            'Codice cantiere',
            'Stato',
            'Ore manodopera',
            'Ore mezzi',
            'Meteo',
            'Lavori eseguiti',
            'Note',
            'Compilato da',
            'Approvato da',
          ],
          rows.map((r) => [
            italianDate(r.report_date),
            r.site_name,
            r.site_code,
            STATUS_LABELS[r.status],
            r.labor_hours.replace('.', ','),
            r.vehicle_hours.replace('.', ','),
            r.weather,
            r.work_done,
            r.notes,
            r.created_by_name,
            r.approved_by_name,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="rapportini.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/monthly-hours`,
    async (request, reply) => {
      const session = requireSession(request)
      const query = readMonthlyHours(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('reports.view') || !permissions.has('employees.view')) {
          throw forbidden()
        }
        const values: unknown[] = [`${query.month}-01`]
        const where = [
          'r.report_date >= $1::date',
          "r.report_date < ($1::date + interval '1 month')",
        ]
        if (query.siteId) {
          values.push(query.siteId)
          where.push(`r.site_id = $${values.length}`)
        }
        if (query.status) {
          values.push(query.status)
          where.push(`r.status = $${values.length}`)
        }
        const { rows } = await client.query<{
          id: string
          last_name: string
          first_name: string
          tax_code: string | null
          day: number
          hours: string
          total: string
        }>(
          `select e.id, e.last_name, e.first_name, e.tax_code,
             extract(day from r.report_date)::int as day,
             sum(l.hours)::numeric(8, 2)::text as hours,
             (sum(sum(l.hours)) over (partition by e.id))::numeric(8, 2)::text as total
           from public.daily_report_labor l
           join public.daily_reports r on r.id = l.report_id
           join public.employees e on e.id = l.employee_id
           where ${where.join(' and ')}
           group by e.id, r.report_date
           order by lower(e.last_name), lower(e.first_name), e.id, r.report_date`,
          values,
        )
        const [year = 0, month = 0] = query.month.split('-').map(Number)
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
        const employees = new Map<
          string,
          { head: string[]; cells: (string | null)[]; total: string }
        >()
        for (const r of rows) {
          let entry = employees.get(r.id)
          if (!entry) {
            entry = {
              head: [r.last_name, r.first_name, r.tax_code ?? ''],
              cells: Array.from({ length: days }, () => null),
              total: r.total,
            }
            employees.set(r.id, entry)
          }
          entry.cells[r.day - 1] = /^0+(\.0+)?$/.test(r.hours) ? null : italianQuantity(r.hours)
        }
        // Absences are not tied to a site: they go in the file of the whole company only. A day
        // gets the code of the absence after its hours (e.g. "6 PE 2", or "FE").
        if (!query.siteId) {
          const absences = await client.query<{
            id: string
            last_name: string
            first_name: string
            tax_code: string | null
            kind: AbsenceKind
            first_day: number
            last_day: number
            hours: string | null
          }>(
            `select e.id, e.last_name, e.first_name, e.tax_code, a.kind,
               extract(day from greatest(a.starts_on, $1::date))::int as first_day,
               extract(day from least(a.ends_on, ($1::date + interval '1 month' - interval '1 day')::date))::int
                 as last_day,
               a.hours::text as hours
             from public.employee_absences a
             join public.employees e on e.id = a.employee_id
             where a.ends_on >= $1::date and a.starts_on < ($1::date + interval '1 month')`,
            [`${query.month}-01`],
          )
          for (const a of absences.rows) {
            let entry = employees.get(a.id)
            if (!entry) {
              entry = {
                head: [a.last_name, a.first_name, a.tax_code ?? ''],
                cells: Array.from({ length: days }, () => null),
                total: '0',
              }
              employees.set(a.id, entry)
            }
            const code = ABSENCE_CODES[a.kind] + (a.hours ? ` ${italianQuantity(a.hours)}` : '')
            for (let d = a.first_day; d <= a.last_day; d++) {
              const cell = entry.cells[d - 1]
              entry.cells[d - 1] = cell ? `${cell} ${code}` : code
            }
          }
        }
        // One order for the people with hours and those with absences only.
        const order = await client.query<{ id: string }>(
          `select id from public.employees where id = any($1::uuid[])
           order by lower(last_name), lower(first_name), id`,
          [[...employees.keys()]],
        )
        return toCsv(
          [
            'Cognome',
            'Nome',
            'Codice fiscale',
            ...Array.from({ length: days }, (_, i) => String(i + 1)),
            'Totale',
          ],
          order.rows.flatMap((o) => {
            const e = employees.get(o.id)
            return e ? [[...e.head, ...e.cells, italianQuantity(e.total)]] : []
          }),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="ore-${query.month}.csv"`)
        .send(csv)
    },
  )

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/monthly-site-hours`,
    async (request, reply) => {
      const session = requireSession(request)
      const query = readMonthlyHours(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('reports.view') || !permissions.has('employees.view')) {
          throw forbidden()
        }
        const values: unknown[] = [`${query.month}-01`]
        const where = [
          'r.report_date >= $1::date',
          "r.report_date < ($1::date + interval '1 month')",
        ]
        if (query.siteId) {
          values.push(query.siteId)
          where.push(`r.site_id = $${values.length}`)
        }
        if (query.status) {
          values.push(query.status)
          where.push(`r.status = $${values.length}`)
        }
        const { rows } = await client.query<{
          last_name: string
          first_name: string
          tax_code: string | null
          site_name: string
          site_code: string | null
          site_address: string | null
          days: number
          hours: string
        }>(
          `select e.last_name, e.first_name, e.tax_code,
             s.name as site_name, s.code as site_code, s.address as site_address,
             count(distinct r.report_date)::int as days,
             sum(l.hours)::numeric(8, 2)::text as hours
           from public.daily_report_labor l
           join public.daily_reports r on r.id = l.report_id
           join public.employees e on e.id = l.employee_id
           join public.sites s on s.id = r.site_id
           where ${where.join(' and ')}
           group by e.id, s.id
           order by lower(e.last_name), lower(e.first_name), e.id, lower(s.name), s.id`,
          values,
        )
        return toCsv(
          [
            'Cognome',
            'Nome',
            'Codice fiscale',
            'Cantiere',
            'Codice cantiere',
            'Indirizzo cantiere',
            'Giorni',
            'Ore',
          ],
          rows.map((r) => [
            r.last_name,
            r.first_name,
            r.tax_code ?? '',
            r.site_name,
            r.site_code ?? '',
            r.site_address ?? '',
            String(r.days),
            italianQuantity(r.hours),
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="ore-cantieri-${query.month}.csv"`)
        .send(csv)
    },
  )

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

  app.get<{ Params: Params }>(`${base}/:report/pdf`, async (request, reply) => {
    const session = requireSession(request)
    const pdf = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('reports.view')) throw notFound()
      const id = request.params.report ?? ''
      if (!UUID.test(id)) throw notFound()
      const report = await readOne(client, id)
      if (!report) throw notFound()
      const { row } = report
      const site = await client.query<{ address: string | null }>(
        'select address from public.sites where id = $1',
        [row.site_id],
      )
      const common = await pdfCommon(client)
      return {
        name: [row.report_date, row.site_code].filter(Boolean).join('-'),
        buffer: reportPdf(pdfData(common, report, site.rows[0]?.address ?? null)),
      }
    })
    return sendPdf(reply, `rapportino-${pdf.name}`, pdf.buffer)
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/pdf`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const errors: FieldErrors = {}
      for (const [field, value] of [
        ['filter[site]', list.siteId],
        ['filter[from]', list.from],
        ['filter[to]', list.to],
      ] as const) {
        if (value === undefined) errors[field] = ['Campo obbligatorio.']
      }
      if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
      const pdf = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('reports.view')) throw forbidden()
        const site = await client.query<{ code: string | null; address: string | null }>(
          'select code, address from public.sites where id = $1',
          [list.siteId],
        )
        const found = site.rows[0]
        if (!found) throw notFound()
        const values: unknown[] = [list.siteId, list.from, list.to]
        let status = ''
        if (list.status) {
          values.push(list.status)
          status = 'and r.status = $4'
        }
        const { rows } = await client.query<{ id: string }>(
          `select r.id from public.daily_reports r
           where r.site_id = $1 and r.report_date between $2::date and $3::date ${status}
           order by r.report_date, r.id limit ${MAX_WORK_LOG + 1}`,
          values,
        )
        if (rows.length > MAX_WORK_LOG) {
          throw new ValidationFailed({
            'filter[to]': [`Più di ${MAX_WORK_LOG} rapportini: accorcia il periodo.`],
          })
        }
        if (rows.length === 0) {
          throw new ValidationFailed({ 'filter[from]': ['Nessun rapportino nel periodo.'] })
        }
        const common = await pdfCommon(client)
        const reports: ReportPdfData[] = []
        for (const { id } of rows) {
          const report = await readOne(client, id)
          if (report) reports.push(pdfData(common, report, found.address))
        }
        return {
          name: [found.code, list.from, list.to].filter(Boolean).join('-'),
          buffer: reportsPdf(reports),
        }
      })
      return sendPdf(reply, `giornale-lavori-${pdf.name}`, pdf.buffer)
    },
  )

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

interface OptionRow {
  id: string
  first_name?: string
  last_name?: string
  name?: string
  plate?: string | null
  in_team?: boolean
  absence?: AbsenceKind | null
  absence_hours?: string | null
  documents_expired?: boolean
}

/** Hours proposed for each team member in a new report: a standard working day. */
export const STANDARD_DAY_HOURS = '8.00'

export function dailyReportTodayRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/daily-reports/today',
    async (request, reply) => {
      const session = requireSession(request)
      const errors: FieldErrors = {}
      const siteId = request.query.site
      if (typeof siteId !== 'string' || !UUID.test(siteId)) errors.site = ['Scegli il cantiere.']
      const day = request.query.date
      if (day !== undefined && (typeof day !== 'string' || !isIsoDate(day))) {
        errors.date = ['Data non valida (AAAA-MM-GG).']
      }
      const copy = request.query.copy_previous
      if (copy !== undefined && copy !== 'true' && copy !== 'false') {
        errors.copy_previous = ['Indica true o false.']
      }
      if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
      const body = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('reports.view')) throw forbidden()
        const site = await client.query<{ id: string; name: string; code: string | null }>(
          'select id, name, code from public.sites where id = $1',
          [siteId],
        )
        const siteRow = site.rows[0]
        if (!siteRow) throw notFound()
        // "Today" is the Italian calendar day, whatever the server's time zone.
        const { rows: dates } = await client.query<{ date: string }>(
          `select coalesce($1::date, (now() at time zone 'Europe/Rome')::date)::text as date`,
          [typeof day === 'string' ? day : null],
        )
        const date = dates[0]?.date ?? ''
        const existing = await client.query<{ id: string }>(
          'select id from public.daily_reports where site_id = $1 and report_date = $2',
          [siteRow.id, date],
        )
        const report = existing.rows[0] ? await readOne(client, existing.rows[0].id) : undefined
        const employees = await client.query<OptionRow>(
          `select e.id, e.first_name, e.last_name,
             exists (select 1 from public.site_team t
                     where t.site_id = $1 and t.employee_id = e.id) as in_team,
             a.kind as absence, a.hours::text as absence_hours,
             ${employeeDocumentsExpiredOn('$2::date')} as documents_expired
           from public.employees e
           left join lateral (
             select x.kind, x.hours from public.employee_absences x
             where x.employee_id = e.id and $2::date between x.starts_on and x.ends_on
             order by x.starts_on limit 1
           ) a on true
           where e.active
           order by lower(e.last_name), lower(e.first_name), e.id`,
          [siteRow.id, date],
        )
        // Who is away the whole day stays out of the proposal. The kind of the absence (a
        // sick leave, say) is for who sees the employees.
        const seesAbsences = permissions.has('employees.view')
        const away = new Set(
          employees.rows.filter((e) => e.absence && e.absence_hours === null).map((e) => e.id),
        )
        const vehicles = await client.query<OptionRow>(
          `select v.id, v.name, v.plate,
             ${vehicleDocumentsExpiredOn('$1::date')} as documents_expired
           from public.vehicles v where v.active
           order by lower(v.name), v.id`,
          [date],
        )
        let labor = employees.rows
          .filter((e) => e.in_team && !away.has(e.id))
          .map((e) => ({
            employee_id: e.id,
            hours: STANDARD_DAY_HOURS,
            description: null as string | null,
          }))
        let usedVehicles: { vehicle_id: string; hours: string; description: string | null }[] = []
        if (copy === 'true') {
          const previous = await client.query<{ id: string }>(
            `select id from public.daily_reports where site_id = $1 and report_date < $2
             order by report_date desc limit 1`,
            [siteRow.id, date],
          )
          const previousId = previous.rows[0]?.id
          if (previousId) {
            // Only people and vehicles still active, in the order of the lists to choose from.
            const people = await client.query<{
              employee_id: string
              hours: string
              description: string | null
            }>(
              `select l.employee_id, l.hours::text as hours, l.description
               from public.daily_report_labor l
               join public.employees e on e.id = l.employee_id and e.active
               where l.report_id = $1
               order by lower(e.last_name), lower(e.first_name), e.id`,
              [previousId],
            )
            const machines = await client.query<{
              vehicle_id: string
              hours: string
              description: string | null
            }>(
              `select r.vehicle_id, r.hours::text as hours, r.description
               from public.daily_report_vehicles r
               join public.vehicles v on v.id = r.vehicle_id and v.active
               where r.report_id = $1
               order by lower(v.name), v.id`,
              [previousId],
            )
            labor = people.rows.filter((p) => !away.has(p.employee_id))
            usedVehicles = machines.rows
          }
        }
        return {
          date,
          site: siteRow,
          report: report ? toContract(report) : null,
          proposal: {
            site_id: siteRow.id,
            date,
            weather: null,
            work_done: null,
            notes: null,
            labor,
            vehicles: usedVehicles,
          },
          employees: employees.rows.map((e) => ({
            id: e.id,
            first_name: e.first_name ?? '',
            last_name: e.last_name ?? '',
            in_team: e.in_team ?? false,
            away: away.has(e.id),
            absence: seesAbsences ? (e.absence ?? null) : null,
            absence_hours: seesAbsences && e.absence ? (e.absence_hours ?? null) : null,
            documents_expired: e.documents_expired ?? false,
          })),
          vehicles: vehicles.rows.map((v) => ({
            id: v.id,
            name: v.name ?? '',
            plate: v.plate ?? null,
            documents_expired: v.documents_expired ?? false,
          })),
        }
      })
      return reply.send(body)
    },
  )
}
