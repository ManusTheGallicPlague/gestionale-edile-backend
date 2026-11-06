import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed, forbidden } from '../http/errors.js'
import type { FieldErrors } from '../http/errors.js'
import { UUID } from '../deadlines/input.js'
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
] as const

interface AuditRow {
  id: string
  entity: string
  entity_id: string
  action: string
  fields: string[]
  user_id: string | null
  user_name: string | null
  created_at: Date
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
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, entity, entityId, userId }
}

export function auditLogRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/audit-log',
    async (request) => {
      const session = requireSession(request)
      const list = readList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('audit.view')) throw forbidden()
        const where = ['true']
        const values: unknown[] = []
        const add = (sql: (p: string) => string, value: unknown) => {
          values.push(value)
          where.push(sql(`$${values.length}`))
        }
        if (list.entity) add((p) => `a.entity = ${p}`, list.entity)
        if (list.entityId) add((p) => `a.entity_id = ${p}`, list.entityId)
        if (list.userId) add((p) => `a.user_id = ${p}`, list.userId)
        const filters = values.length
        values.push(list.perPage, (list.page - 1) * list.perPage)
        const { rows } = await client.query<AuditRow>(
          `with page as (
             select a.id, a.entity, a.entity_id, a.action, a.fields, a.user_id, a.created_at
             from public.audit_log a where ${where.join(' and ')}
             order by a.id desc limit $${filters + 1} offset $${filters + 2}
           )
           select p.id::text as id, p.entity, p.entity_id, p.action, p.fields, p.user_id,
             u.name as user_name, p.created_at
           from page p
           left join app.audit_users(
             (select coalesce(array_agg(distinct user_id), '{}') from page)
           ) u on u.user_id = p.user_id
           order by p.id desc`,
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
}
