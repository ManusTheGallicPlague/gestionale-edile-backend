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
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { formatQuoteNumber } from '../quotes/number.js'
import { DOCUMENT_FILTERS, EMPLOYEE_DOCUMENTS_SQL } from './employees.js'
import { onSite } from './site-subcontractors.js'
import { teamHas } from './site-team.js'
import { COMPLIANCE, COMPLIANCE_SQL } from './suppliers.js'

export const SITE_STATUSES = ['planned', 'active', 'suspended', 'completed'] as const
type Status = (typeof SITE_STATUSES)[number]
const STATUS_LABELS: Record<Status, string> = {
  planned: 'Da iniziare',
  active: 'In corso',
  suspended: 'Sospeso',
  completed: 'Chiuso',
}

interface SiteValues {
  code: string | null
  name: string
  client_id: string | null
  address: string | null
  status: Status
  start_on: string | null
  end_on: string | null
  budget_cents: string | null
  notes: string | null
}
interface Location {
  latitude: string
  longitude: string
}
interface SiteInput extends SiteValues {
  /** undefined: not sent, so unchanged on update and null on create. */
  location: Location | null | undefined
}
const COLUMNS = [
  'code',
  'name',
  'client_id',
  'address',
  'status',
  'start_on',
  'end_on',
  'budget_cents',
  'notes',
] as const

interface SiteRow extends SiteValues {
  id: string
  latitude: string | null
  longitude: string | null
  client_name: string | null
  quote_id: string | null
  quote_year: number | null
  quote_seq: number | null
  quote_revision: number | null
  team_documents_expired: boolean
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; site?: string }

const SELECT = `select s.id, s.code, s.name, s.client_id, s.address, s.status,
    s.start_on::text as start_on, s.end_on::text as end_on, s.budget_cents::text as budget_cents,
    s.notes, s.latitude::text as latitude, s.longitude::text as longitude, s.version, s.created_at, s.updated_at, c.name as client_name,
    s.quote_id, q.number_year as quote_year, q.number_seq as quote_seq, q.revision as quote_revision,
    ${teamHas('s.id', EMPLOYEE_DOCUMENTS_SQL.expired)} as team_documents_expired
  from public.sites s
  left join public.clients c on c.id = s.client_id
  left join public.quotes q on q.id = s.quote_id`

const SORTS = {
  name: 'lower(s.name) asc, s.id asc',
  '-name': 'lower(s.name) desc, s.id desc',
  code: 'lower(s.code) asc nulls last, s.id asc',
  '-code': 'lower(s.code) desc nulls last, s.id desc',
  start_on: 's.start_on asc nulls last, s.id asc',
  '-start_on': 's.start_on desc nulls last, s.id desc',
  updated_at: 's.updated_at asc, s.id asc',
  '-updated_at': 's.updated_at desc, s.id desc',
} as const

function toContract(row: SiteRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    client_id: row.client_id,
    client: row.client_id ? { id: row.client_id, name: row.client_name ?? '' } : null,
    address: row.address,
    status: row.status,
    start_on: row.start_on,
    end_on: row.end_on,
    budget: row.budget_cents === null ? null : centsToAmount(row.budget_cents),
    notes: row.notes,
    location:
      row.latitude === null || row.longitude === null
        ? null
        : { latitude: row.latitude, longitude: row.longitude },
    quote: row.quote_id
      ? {
          id: row.quote_id,
          number: formatQuoteNumber(row.quote_year, row.quote_seq, row.quote_revision),
        }
      : null,
    team_documents_expired: row.team_documents_expired,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export const sendSite = (reply: FastifyReply, row: SiteRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.siteMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

const COORDINATE = /^(-?)(\d{1,3})(?:\.(\d{1,6}))?$/

/** A coordinate as a string with six decimals, or null when invalid or out of range. */
function coordinate(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const match = COORDINATE.exec(value.trim())
  if (!match) return null
  const [, sign = '', whole = '', decimals = ''] = match
  const units = Number(whole)
  const fraction = decimals.padEnd(6, '0')
  if (units > max || (units === max && Number(fraction) > 0)) return null
  const zero = units === 0 && Number(fraction) === 0
  return `${zero ? '' : sign}${units}.${fraction}`
}

function parseLocation(value: unknown, add: (field: string, message: string) => void) {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object' || Array.isArray(value)) {
    add('location', 'Deve essere un oggetto con latitude e longitude, o null.')
    return undefined
  }
  const raw = value as Record<string, unknown>
  const latitude = coordinate(raw.latitude, 90)
  const longitude = coordinate(raw.longitude, 180)
  if (latitude === null) {
    add('location.latitude', 'Latitudine non valida: gradi decimali da -90 a 90 (es. 45.070312).')
  }
  if (longitude === null) {
    add(
      'location.longitude',
      'Longitudine non valida: gradi decimali da -180 a 180 (es. 7.686856).',
    )
  }
  return latitude === null || longitude === null ? undefined : { latitude, longitude }
}

export function parseSiteInput(body: unknown): { input: SiteInput } | { errors: FieldErrors } {
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
  const date = (field: string): string | null => {
    const value = text(field, 10)
    if (value !== null && !errors[field] && !isIsoDate(value)) {
      add(field, 'Data non valida (AAAA-MM-GG).')
      return null
    }
    return value
  }
  const code = text('code', 50)
  const name = text('name', 200)
  if (name === null && !errors.name) add('name', 'Il nome è obbligatorio.')
  const client_id = text('client_id', 36)
  if (client_id !== null && !UUID.test(client_id) && !errors.client_id) {
    add('client_id', 'Cliente non trovato.')
  }
  const address = text('address', 300)
  const statusValue = text('status', 10)
  const status = SITE_STATUSES.find((s) => s === statusValue)
  if (!status && !errors.status) add('status', 'Stato non valido.')
  const start_on = date('start_on')
  const end_on = date('end_on')
  if (start_on && end_on && end_on < start_on) {
    add('end_on', 'La fine prevista non può essere prima dell’inizio.')
  }
  const budgetText = text('budget', 20)
  let budget_cents: string | null = null
  if (budgetText !== null && !errors.budget) {
    budget_cents = amountToCents(budgetText)
    if (budget_cents === null) add('budget', 'Importo non valido (es. 1234.50).')
  }
  const notes = text('notes', 2000)
  const location = parseLocation(raw.location, add)
  if (Object.keys(errors).length > 0 || !name || !status) return { errors }
  return {
    input: {
      code,
      name,
      client_id,
      address,
      status,
      start_on,
      end_on,
      budget_cents,
      notes,
      location,
    },
  }
}

function writeFailed(error: unknown): never {
  if (isForeignKeyViolation(error)) {
    throw new ValidationFailed({ client_id: ['Cliente non trovato.'] })
  }
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({ code: ['Esiste già un cantiere con questo codice.'] })
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
  const sortValue = single('sort') ?? '-updated_at'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const statusValue = single('filter[status]')
  const status = SITE_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const clientId = single('filter[client]')
  if (clientId !== undefined && !UUID.test(clientId)) {
    errors['filter[client]'] = ['Identificativo non valido.']
  }
  const reportMissingValue = single('filter[report_missing]')
  if (
    reportMissingValue !== undefined &&
    reportMissingValue !== 'true' &&
    reportMissingValue !== 'false'
  ) {
    errors['filter[report_missing]'] = ['Indica true o false.']
  }
  const reportMissing = reportMissingValue === undefined ? undefined : reportMissingValue === 'true'
  const complianceValue = single('filter[subcontractor_compliance]')
  const subcontractorCompliance = COMPLIANCE.find((c) => c === complianceValue)
  if (complianceValue !== undefined && !subcontractorCompliance) {
    errors['filter[subcontractor_compliance]'] = ['Vale expired, expiring oppure no_valid_durc.']
  }
  const teamDocumentsValue = single('filter[team_documents]')
  const teamDocuments = DOCUMENT_FILTERS.find((d) => d === teamDocumentsValue)
  if (teamDocumentsValue !== undefined && !teamDocuments) {
    errors['filter[team_documents]'] = ['Vale expired oppure expiring.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    page,
    perPage,
    sort: sort ?? '-updated_at',
    search,
    status,
    clientId,
    reportMissing,
    subcontractorCompliance,
    teamDocuments,
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.status) add((p) => `s.status = ${p}`, list.status)
  if (list.clientId) add((p) => `s.client_id = ${p}`, list.clientId)
  if (list.reportMissing !== undefined) {
    // Active sites without (true) or with (false) a daily report dated today in Italy, in
    // any status: the same sites counted in reports.missing_today of the dashboard.
    where.push(
      `s.status = 'active' and ${list.reportMissing ? 'not ' : ''}exists (
         select 1 from public.daily_reports r
         where r.site_id = s.id and r.report_date = (now() at time zone 'Europe/Rome')::date)`,
    )
  }
  if (list.subcontractorCompliance) {
    // Sites with at least one subcontractor in that state, as listSiteSubcontractors.
    where.push(
      `exists (select 1 from public.suppliers
         where ${onSite('s.id')} and ${COMPLIANCE_SQL[list.subcontractorCompliance]})`,
    )
  }
  if (list.teamDocuments) {
    // Sites with a team member in that state, as documents_expired in getSiteTeam.
    where.push(teamHas('s.id', EMPLOYEE_DOCUMENTS_SQL[list.teamDocuments]))
  }
  if (list.search) {
    add(
      (p) =>
        `(s.name ilike ${p} or s.code ilike ${p} or s.address ilike ${p} or c.name ilike ${p})`,
      `%${escapeLike(list.search)}%`,
    )
  }
  return { where, values }
}

export async function readSite(client: PoolClient, id: string) {
  const { rows } = await client.query<SiteRow>(`${SELECT} where s.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readSite(client, id))) throw notFound()
  throw new ApiError(412, messages.siteStale, 'stale_record')
}

export function siteRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/sites'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw forbidden()
      if (list.subcontractorCompliance && !permissions.has('suppliers.view')) throw forbidden()
      if (list.teamDocuments === 'expiring' && !permissions.has('employees.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<SiteRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.sites s
         left join public.clients c on c.id = s.client_id where ${where.join(' and ')}`,
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
        if (!permissions.has('sites.view')) throw forbidden()
        if (list.subcontractorCompliance && !permissions.has('suppliers.view')) throw forbidden()
        if (list.teamDocuments === 'expiring' && !permissions.has('employees.view')) {
          throw forbidden()
        }
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<SiteRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Codice',
            'Nome',
            'Cliente',
            'Indirizzo',
            'Stato',
            'Inizio',
            'Fine prevista',
            'Budget',
            'Note',
          ],
          rows.map((r) => [
            r.code,
            r.name,
            r.client_name,
            r.address,
            STATUS_LABELS[r.status],
            r.start_on && italianDate(r.start_on),
            r.end_on && italianDate(r.end_on),
            r.budget_cents && italianAmount(r.budget_cents),
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="cantieri.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:site`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      const id = request.params.site ?? ''
      if (!UUID.test(id)) throw notFound()
      return readSite(client, id)
    })
    if (!row) throw notFound()
    return sendSite(reply, row)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.create')) throw forbidden()
      const parsed = parseSiteInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.sites (company_id, ${COLUMNS.join(', ')}, latitude, longitude)
           values (app.current_company_id(), ${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')},
             $${COLUMNS.length + 1}, $${COLUMNS.length + 2})
           returning id`,
          [
            ...COLUMNS.map((f) => parsed.input[f]),
            parsed.input.location?.latitude ?? null,
            parsed.input.location?.longitude ?? null,
          ],
        )
        .catch(writeFailed)
      return readSite(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return sendSite(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:site`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.update')) throw forbidden()
      const id = request.params.site ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseSiteInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const columns: string[] = [...COLUMNS]
      const values: unknown[] = COLUMNS.map((f) => parsed.input[f])
      const { location } = parsed.input
      if (location !== undefined) {
        columns.push('latitude', 'longitude')
        values.push(location?.latitude ?? null, location?.longitude ?? null)
      }
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.sites
           set ${columns.map((f, i) => `${f} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}`,
          values,
        )
        .catch(writeFailed)
      if (!rowCount) return missingOrStale(client, id)
      return readSite(client, id)
    })
    if (!row) throw notFound()
    return sendSite(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:site`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.delete')) throw forbidden()
      const id = request.params.site ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client
        .query('delete from public.sites where id = $1 and version = $2', [id, version])
        .catch((error: unknown) => {
          // Daily reports point here with "on delete restrict".
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.siteHasDocuments, 'has_documents')
          }
          throw error
        })
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
