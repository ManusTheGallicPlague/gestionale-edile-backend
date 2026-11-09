import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed, forbidden } from '../http/errors.js'
import type { FieldErrors } from '../http/errors.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import { requireSession } from '../http/request-context.js'

const ENTITIES = [
  'client',
  'supplier',
  'deadline',
  'estimate',
  'quote',
  'site',
  'employee',
  'vehicle',
  'daily_report',
  'site_cost',
  'site_document',
  'purchase_order',
  'warehouse_item',
  'invoice',
  'progress_statement',
  'price_list',
  'site_activity',
  'employee_absence',
  'vehicle_maintenance',
  'vehicle_refueling',
  'vehicle_document',
  'employee_document',
] as const

/** Italian name of each kind of record, for the CSV. */
const ENTITY_LABELS: Record<(typeof ENTITIES)[number], string> = {
  client: 'Cliente',
  supplier: 'Fornitore',
  deadline: 'Scadenza',
  estimate: 'Computo metrico',
  quote: 'Preventivo',
  site: 'Cantiere',
  employee: 'Dipendente',
  vehicle: 'Mezzo',
  daily_report: 'Rapportino',
  site_cost: 'Costo',
  site_document: 'Documento del cantiere',
  purchase_order: 'Ordine',
  warehouse_item: 'Articolo di magazzino',
  invoice: 'Fattura',
  progress_statement: 'SAL',
  price_list: 'Prezzario',
  site_activity: 'Attività del cronoprogramma',
  employee_absence: 'Assenza',
  vehicle_maintenance: 'Manutenzione',
  vehicle_refueling: 'Rifornimento',
  vehicle_document: 'Documento del mezzo',
  employee_document: 'Documento del dipendente',
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Creazione',
  update: 'Modifica',
  delete: 'Eliminazione',
}

interface AuditRow {
  id: string
  entity: string
  entity_id: string
  action: string
  fields: string[]
  user_id: string | null
  user_name: string | null
  created_at: Date
  local_time: string
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
  const id = (name: string): string | undefined => {
    const value = single(name)
    if (value !== undefined && !UUID.test(value)) errors[name] = ['Identificativo non valido.']
    return value
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const entityValue = single('filter[entity]')
  const entity = ENTITIES.find((e) => e === entityValue)
  if (entityValue !== undefined && !entity) errors['filter[entity]'] = ['Tipo non valido.']
  const entityId = id('filter[entity_id]')
  const userId = id('filter[user]')
  const date = (name: string): string | undefined => {
    const value = single(name)
    if (value !== undefined && !isIsoDate(value)) {
      errors[name] = ['Data non valida: usa il formato AAAA-MM-GG.']
    }
    return value
  }
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, entity, entityId, userId, from, to }
}

/** The day of a change, on Italian time: what filter[from] and filter[to] compare. */
const LOCAL_DAY = `(a.created_at at time zone 'Europe/Rome')::date`

function auditFilters(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.entity) add((p) => `a.entity = ${p}`, list.entity)
  if (list.entityId) add((p) => `a.entity_id = ${p}`, list.entityId)
  if (list.userId) add((p) => `a.user_id = ${p}`, list.userId)
  if (list.from) add((p) => `${LOCAL_DAY} >= ${p}::date`, list.from)
  if (list.to) add((p) => `${LOCAL_DAY} <= ${p}::date`, list.to)
  return { where, values }
}

/** One page (limit, offset) of the log with the authors' names, newest first. */
const pageQuery = (where: string[], limit: string, offset: string) =>
  `with page as (
     select a.id, a.entity, a.entity_id, a.action, a.fields, a.user_id, a.created_at
     from public.audit_log a where ${where.join(' and ')}
     order by a.id desc limit ${limit} offset ${offset}
   )
   select p.id::text as id, p.entity, p.entity_id, p.action, p.fields, p.user_id,
     u.name as user_name, p.created_at,
     to_char(p.created_at at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI') as local_time
   from page p
   left join app.audit_users(
     (select coalesce(array_agg(distinct user_id), '{}') from page)
   ) u on u.user_id = p.user_id
   order by p.id desc`

export function auditLogRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/audit-log',
    async (request) => {
      const session = requireSession(request)
      const list = readList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('audit.view')) throw forbidden()
        const { where, values } = auditFilters(list)
        const filters = values.length
        values.push(list.perPage, (list.page - 1) * list.perPage)
        const { rows } = await client.query<AuditRow>(
          pageQuery(where, `$${filters + 1}`, `$${filters + 2}`),
          values,
        )
        const count = await client.query<{ total: number }>(
          `select count(*)::int as total from public.audit_log a where ${where.join(' and ')}`,
          values.slice(0, filters),
        )
        return {
          data: rows.map((r) => ({
            id: r.id,
            entity: r.entity,
            entity_id: r.entity_id,
            action: r.action,
            fields: r.fields,
            user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
            created_at: r.created_at.toISOString(),
          })),
          meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
        }
      })
    },
  )
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/audit-log/export',
    async (request, reply) => {
      const session = requireSession(request)
      const { where, values } = auditFilters(readList(request.query))
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('audit.view')) throw forbidden()
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<AuditRow>(
          pageQuery(where, `$${values.length}`, '0'),
          values,
        )
        return toCsv(
          ['Data e ora', 'Utente', 'Documento', 'Id del documento', 'Azione', 'Campi'],
          rows.map((r) => [
            r.local_time,
            r.user_id ? r.user_name : null,
            ENTITY_LABELS[r.entity as (typeof ENTITIES)[number]] ?? r.entity,
            r.entity_id,
            ACTION_LABELS[r.action] ?? r.action,
            r.fields.join(', '),
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="registro-modifiche.csv"')
        .send(csv)
    },
  )
}
