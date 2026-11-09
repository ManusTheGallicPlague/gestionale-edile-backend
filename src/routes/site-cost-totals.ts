import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { ValidationFailed, forbidden, type FieldErrors } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { MAX_EXPORT_ROWS, italianAmount, toCsv } from '../csv.js'
import { COST_LINES } from './site-costs.js'
import { SITE_STATUSES, STATUS_LABELS, escapeLike } from './sites.js'

// Qualified with t.: the outer select names its text columns total and remaining, and an
// unqualified order by would sort those strings instead of the numbers.
const SORTS = {
  name: 't.name asc, t.id asc',
  '-name': 't.name desc, t.id desc',
  total: 't.total asc, t.name asc, t.id asc',
  '-total': 't.total desc, t.name asc, t.id asc',
  remaining: 't.remaining asc nulls last, t.name asc, t.id asc',
  '-remaining': 't.remaining desc nulls last, t.name asc, t.id asc',
} as const

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
  const sortValue = single('sort') ?? 'name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const statusValue = single('filter[status]')
  const status = SITE_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const overValue = single('filter[over_budget]')
  if (overValue !== undefined && overValue !== 'true' && overValue !== 'false') {
    errors['filter[over_budget]'] = ['Indica true o false.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    page,
    perPage,
    sort: sort ?? 'name',
    search,
    status,
    overBudget: overValue === undefined ? undefined : overValue === 'true',
  }
}

type List = ReturnType<typeof readList>

interface TotalRow {
  id: string
  name: string
  code: string | null
  status: (typeof SITE_STATUSES)[number]
  labor: string
  vehicles: string
  manual: string
  total: string
  budget: string | null
  remaining: string | null
}

/**
 * One row per site the user can see, with the same total as the site cost summary: labour
 * and vehicles of approved daily reports at today's hourly cost, plus the costs by hand.
 */
function totalsQuery(list: List) {
  const where = ['true']
  const values: unknown[] = []
  if (list.status) {
    values.push(list.status)
    where.push(`status = $${values.length}`)
  }
  if (list.search) {
    values.push(`%${escapeLike(list.search)}%`)
    where.push(`(name ilike $${values.length} or code ilike $${values.length})`)
  }
  if (list.overBudget === true) where.push('remaining < 0')
  if (list.overBudget === false) where.push('(remaining is null or remaining >= 0)')
  const sql = `with costs as (
      select site_id,
        coalesce(sum(cents) filter (where kind = 'labor'), 0) as labor,
        coalesce(sum(cents) filter (where kind = 'vehicles'), 0) as vehicles,
        coalesce(sum(cents) filter (where kind = 'other'), 0) as manual
      from (${COST_LINES}) x group by site_id
    ), totals as (
      select s.id, s.name, s.code, s.status, s.budget_cents as budget,
        coalesce(c.labor, 0) as labor, coalesce(c.vehicles, 0) as vehicles,
        coalesce(c.manual, 0) as manual,
        coalesce(c.labor + c.vehicles + c.manual, 0) as total,
        s.budget_cents - coalesce(c.labor + c.vehicles + c.manual, 0) as remaining
      from public.sites s left join costs c on c.site_id = s.id
    )
    select * from totals where ${where.join(' and ')}`
  return { sql, values }
}

async function readTotals(client: PoolClient, list: List, limit: number, offset: number) {
  const { sql, values } = totalsQuery(list)
  const filters = values.length
  const { rows } = await client.query<TotalRow>(
    `select id, name, code, status, labor::bigint::text as labor,
       vehicles::bigint::text as vehicles, manual::bigint::text as manual,
       total::bigint::text as total, budget::text as budget,
       remaining::bigint::text as remaining
     from (${sql}) t order by ${SORTS[list.sort]}
     limit $${filters + 1} offset $${filters + 2}`,
    [...values, limit, offset],
  )
  return rows
}

async function enter(client: PoolClient, company: string) {
  const permissions = await enterCompany(client, company)
  if (!permissions.has('costs.view') || !permissions.has('sites.view')) throw forbidden()
}

const overBudget = (r: TotalRow) => r.remaining !== null && BigInt(r.remaining) < 0n

/** Costs of every site against its budget, for the costs page, and the same list in CSV. */
export function siteCostTotalRoutes(app: FastifyInstance, db: Db): void {
  const base = '/api/companies/:company/site-costs/totals'

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    base,
    async (request) => {
      const session = requireSession(request)
      const list = readList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        await enter(client, request.params.company)
        const rows = await readTotals(client, list, list.perPage, (list.page - 1) * list.perPage)
        const { sql, values } = totalsQuery(list)
        const sums = await client.query<{ count: number; total: string; budget: string }>(
          `select count(*)::int as count, coalesce(sum(total), 0)::bigint::text as total,
             coalesce(sum(budget), 0)::bigint::text as budget from (${sql}) t`,
          values,
        )
        return {
          data: rows.map((r) => ({
            site: { id: r.id, name: r.name, code: r.code, status: r.status },
            labor: centsToAmount(r.labor),
            vehicles: centsToAmount(r.vehicles),
            manual: centsToAmount(r.manual),
            total: centsToAmount(r.total),
            budget: r.budget === null ? null : centsToAmount(r.budget),
            budget_remaining: r.remaining === null ? null : centsToAmount(r.remaining),
            over_budget: overBudget(r),
          })),
          meta: { total: sums.rows[0]?.count ?? 0, page: list.page, per_page: list.perPage },
          total_amount: centsToAmount(sums.rows[0]?.total ?? '0'),
          budget_amount: centsToAmount(sums.rows[0]?.budget ?? '0'),
        }
      })
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        await enter(client, request.params.company)
        const rows = await readTotals(client, list, MAX_EXPORT_ROWS, 0)
        return toCsv(
          [
            'Cantiere',
            'Codice',
            'Stato',
            'Manodopera',
            'Mezzi',
            'Costi inseriti',
            'Totale',
            'Budget',
            'Residuo',
            'Sopra budget',
          ],
          rows.map((r) => [
            r.name,
            r.code,
            STATUS_LABELS[r.status],
            italianAmount(r.labor),
            italianAmount(r.vehicles),
            italianAmount(r.manual),
            italianAmount(r.total),
            r.budget === null ? null : italianAmount(r.budget),
            r.remaining === null ? null : italianAmount(r.remaining),
            overBudget(r) ? 'Sì' : 'No',
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="costi-cantieri.csv"')
        .send(csv)
    },
  )
}
