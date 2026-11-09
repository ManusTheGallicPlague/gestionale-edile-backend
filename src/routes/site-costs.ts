import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import { DUE_CENTS, PAID_CENTS, REMAINING_CENTS } from './invoices.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MAX_EXPORT_ROWS, italianAmount, italianDate, toCsv } from '../csv.js'

export const COST_CATEGORIES = ['materials', 'rentals', 'subcontract', 'other'] as const
type Category = (typeof COST_CATEGORIES)[number]

interface CostValues {
  site_id: string
  cost_date: string
  category: Category
  description: string
  supplier_id: string | null
  amount_cents: string
  notes: string | null
}
const COLUMNS = [
  'site_id',
  'cost_date',
  'category',
  'description',
  'supplier_id',
  'amount_cents',
  'notes',
] as const

interface CostRow extends CostValues {
  id: string
  site_name: string
  site_code: string | null
  supplier_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; cost?: string }

const CATEGORY_LABELS: Record<Category, string> = {
  materials: 'Materiali',
  rentals: 'Noli',
  subcontract: 'Subappalti',
  other: 'Altro',
}

const SELECT = `select k.id, k.site_id, s.name as site_name, s.code as site_code,
    k.cost_date::text as cost_date, k.category, k.description, k.supplier_id,
    p.name as supplier_name, k.amount_cents::text as amount_cents, k.notes, k.version,
    k.created_at, k.updated_at
  from public.site_costs k
  join public.sites s on s.id = k.site_id
  left join public.suppliers p on p.id = k.supplier_id`

const SORTS = {
  date: 'k.cost_date asc, k.id asc',
  '-date': 'k.cost_date desc, k.id desc',
  amount: 'k.amount_cents asc, k.id asc',
  '-amount': 'k.amount_cents desc, k.id desc',
} as const

function toContract(row: CostRow) {
  return {
    id: row.id,
    site_id: row.site_id,
    site: { id: row.site_id, name: row.site_name, code: row.site_code },
    date: row.cost_date,
    category: row.category,
    description: row.description,
    supplier_id: row.supplier_id,
    supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? '' } : null,
    amount: centsToAmount(row.amount_cents),
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.costMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseCostInput(body: unknown): CostValues {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
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
  const site_id = text('site_id', 36)
  if (site_id === null && !errors.site_id) add('site_id', 'Scegli il cantiere.')
  else if (site_id !== null && !UUID.test(site_id)) add('site_id', 'Cantiere non trovato.')
  const cost_date = text('date', 10)
  if (cost_date === null && !errors.date) add('date', 'Indica la data.')
  else if (cost_date !== null && !errors.date && !isIsoDate(cost_date)) {
    add('date', 'Data non valida (AAAA-MM-GG).')
  }
  const categoryValue = text('category', 20)
  const category = COST_CATEGORIES.find((c) => c === categoryValue)
  if (!category && !errors.category) add('category', 'Categoria non valida.')
  const description = text('description', 300)
  if (description === null && !errors.description) add('description', 'Descrivi il costo.')
  const supplier_id = text('supplier_id', 36)
  if (supplier_id !== null && !UUID.test(supplier_id) && !errors.supplier_id) {
    add('supplier_id', 'Fornitore non trovato.')
  }
  const amountText = text('amount', 20)
  let amount_cents: string | null = null
  if (amountText === null && !errors.amount) add('amount', 'Indica l’importo.')
  else if (amountText !== null && !errors.amount) {
    amount_cents = amountToCents(amountText)
    if (amount_cents === null || amount_cents.startsWith('-')) {
      add('amount', 'Importo non valido (es. 1234.50).')
    }
  }
  const notes = text('notes', 2000)
  if (
    Object.keys(errors).length > 0 ||
    !site_id ||
    !cost_date ||
    !category ||
    !description ||
    !amount_cents
  ) {
    throw new ValidationFailed(errors)
  }
  return { site_id, cost_date, category, description, supplier_id, amount_cents, notes }
}

/** Site and supplier must be of the company: errors under their own field. */
async function checkReferences(client: PoolClient, input: CostValues) {
  const errors: FieldErrors = {}
  const site = await client.query('select 1 from public.sites where id = $1', [input.site_id])
  if (!site.rowCount) errors.site_id = ['Cantiere non trovato.']
  if (input.supplier_id) {
    const supplier = await client.query('select 1 from public.suppliers where id = $1', [
      input.supplier_id,
    ])
    if (!supplier.rowCount) errors.supplier_id = ['Fornitore non trovato.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
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
  const id = (name: string) => {
    const value = single(name)
    if (value !== undefined && !UUID.test(value)) errors[name] = ['Identificativo non valido.']
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
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const sortValue = single('sort') ?? '-date'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const categoryValue = single('filter[category]')
  const category = COST_CATEGORIES.find((c) => c === categoryValue)
  if (categoryValue !== undefined && !category) {
    errors['filter[category]'] = ['Categoria non valida.']
  }
  const siteId = id('filter[site]')
  const supplierId = id('filter[supplier]')
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-date', category, siteId, supplierId, from, to }
}

async function readOne(client: PoolClient, id: string) {
  const { rows } = await client.query<CostRow>(`${SELECT} where k.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.costStale, 'stale_record')
}

function writeFailed(error: unknown): never {
  // A site or supplier deleted between the check and the write.
  if (isForeignKeyViolation(error)) {
    throw new ValidationFailed({ site_id: ['Cantiere o fornitore non trovato.'] })
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
  if (list.category) add((p) => `k.category = ${p}`, list.category)
  if (list.siteId) add((p) => `k.site_id = ${p}`, list.siteId)
  if (list.supplierId) add((p) => `k.supplier_id = ${p}`, list.supplierId)
  if (list.from) add((p) => `k.cost_date >= ${p}`, list.from)
  if (list.to) add((p) => `k.cost_date <= ${p}`, list.to)
  return { where, values }
}

export function siteCostRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/costs'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('costs.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<CostRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number; amount: string }>(
        `select count(*)::int as total, coalesce(sum(k.amount_cents), 0)::text as amount
         from public.site_costs k where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(toContract),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
        total_amount: centsToAmount(count.rows[0]?.amount ?? '0'),
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
        if (!permissions.has('costs.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<CostRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Data',
            'Cantiere',
            'Codice cantiere',
            'Categoria',
            'Descrizione',
            'Fornitore',
            'Importo',
            'Note',
          ],
          rows.map((r) => [
            italianDate(r.cost_date),
            r.site_name,
            r.site_code,
            CATEGORY_LABELS[r.category],
            r.description,
            r.supplier_name,
            italianAmount(r.amount_cents),
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="costi.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:cost`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('costs.view')) throw notFound()
      const id = request.params.cost ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('costs.create')) throw forbidden()
      const input = parseCostInput(request.body)
      await checkReferences(client, input)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.site_costs (company_id, ${COLUMNS.join(', ')})
           values (app.current_company_id(), ${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           returning id`,
          COLUMNS.map((f) => input[f]),
        )
        .catch(writeFailed)
      return readOne(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.put<{ Params: Params }>(`${base}/:cost`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('costs.update')) throw forbidden()
      const id = request.params.cost ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseCostInput(request.body)
      await checkReferences(client, input)
      const values: unknown[] = COLUMNS.map((f) => input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.site_costs
           set ${COLUMNS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}`,
          values,
        )
        .catch(writeFailed)
      if (!rowCount) return missingOrStale(client, id)
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.delete<{ Params: Params }>(`${base}/:cost`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('costs.delete')) throw forbidden()
      const id = request.params.cost ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.site_costs where id = $1 and version = $2',
        [id, version],
      )
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}

interface SummaryRow {
  id: string
  name: string
  code: string | null
  budget_cents: string | null
  labor_hours: string
  labor_cents: string
  vehicle_hours: string
  vehicle_cents: string
  materials: string
  rentals: string
  subcontract: string
  other: string
  missing_rates: number
  invoiced: string
  collected: string
  to_collect: string
  certified: string
  certified_uninvoiced: string
  retention_held: string
  retention_released: string
  warehouse_cents: string
  warehouse_movements: number
  warehouse_returns: number
  warehouse_missing: number
  orders: number
  orders_received: number
  orders_cents: string
  orders_received_cents: string
  orders_invoiced: string
}

/**
 * Costs of one site: labour and vehicles from approved daily reports at today's hourly
 * cost, plus the costs entered by hand, against the budget.
 */
export function siteCostSummaryRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { company: string; site: string } }>(
    '/api/companies/:company/sites/:site/cost-summary',
    async (request, reply) => {
      const session = requireSession(request)
      const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('costs.view')) throw notFound()
        if (!UUID.test(request.params.site)) throw notFound()
        const { rows } = await client.query<SummaryRow>(
          `with labor as (
             select coalesce(sum(l.hours), 0) as hours,
               coalesce(sum(round(l.hours * coalesce(e.hourly_cost_cents, 0))), 0) as cents,
               count(*) filter (where e.hourly_cost_cents is null) as missing
             from public.daily_report_labor l
             join public.daily_reports r on r.id = l.report_id and r.status = 'approved'
             join public.employees e on e.id = l.employee_id
             where r.site_id = $1
           ), machines as (
             select coalesce(sum(v.hours), 0) as hours,
               coalesce(sum(round(v.hours * coalesce(m.hourly_cost_cents, 0))), 0) as cents,
               count(*) filter (where m.hourly_cost_cents is null) as missing
             from public.daily_report_vehicles v
             join public.daily_reports r on r.id = v.report_id and r.status = 'approved'
             join public.vehicles m on m.id = v.vehicle_id
             where r.site_id = $1
           ), manual as (
             select
               coalesce(sum(amount_cents) filter (where category = 'materials'), 0) as materials,
               coalesce(sum(amount_cents) filter (where category = 'rentals'), 0) as rentals,
               coalesce(sum(amount_cents) filter (where category = 'subcontract'), 0)
                 as subcontract,
               coalesce(sum(amount_cents) filter (where category = 'other'), 0) as other
             from public.site_costs where site_id = $1
           ), revenue as (
             select coalesce(sum(i.taxable_cents), 0) as cents,
               coalesce(sum(case when i.paid_on is not null then ${DUE_CENTS}
                 else ${PAID_CENTS} end), 0) as collected,
               coalesce(sum(${REMAINING_CENTS}), 0) as to_collect,
               coalesce(sum(i.taxable_cents) filter (where i.retention_release), 0) as released
             from public.invoices i where i.site_id = $1 and i.direction = 'issued'
           ), certified as (
             select coalesce(sum(a.cents), 0) as cents,
               coalesce(sum(a.cents) filter (where not exists (
                 select 1 from public.invoices i where i.progress_statement_id = p.id
               )), 0) as uninvoiced,
               coalesce(sum(round(a.cents * p.retention_percent / 100)), 0) as retention
             from public.progress_statements p
             join public.estimates e on e.id = p.estimate_id and e.site_id = $1
             cross join lateral (
               select coalesce(sum(round(l.quantity * l.unit_price_cents)), 0) as cents
               from public.progress_statement_lines l where l.statement_id = p.id
             ) a
             where p.status = 'approved'
           ), stock_out as (
             select coalesce(sum(case when m.kind = 'out' then round(m.quantity * c.average)
                 else -round(m.quantity * c.average) end), 0) as cents,
               (count(*) filter (where m.kind = 'out'))::int as movements,
               (count(*) filter (where m.site_return))::int as returns,
               (count(*) filter (where c.average is null))::int as missing
             from public.warehouse_movements m
             cross join lateral (
               select sum(i.quantity * i.unit_cost_cents) / nullif(sum(i.quantity), 0) as average
               from public.warehouse_movements i
               where i.item_id = m.item_id and i.kind = 'in' and i.unit_cost_cents is not null
                 and i.movement_date <= m.movement_date
             ) c
             where m.site_id = $1 and (m.kind = 'out' or m.site_return)
           ), orders as (
             select count(*)::int as count,
               (count(*) filter (where o.status = 'received'))::int as received,
               coalesce(sum(t.cents), 0) as cents,
               coalesce(sum(t.cents) filter (where o.status = 'received'), 0) as received_cents,
               coalesce(sum((select sum(i.taxable_cents) from public.invoices i
                 where i.purchase_order_id = o.id)), 0) as invoiced
             from public.purchase_orders o
             cross join lateral (
               select coalesce(sum(round(l.quantity * l.unit_price_cents)), 0) as cents
               from public.purchase_order_lines l where l.order_id = o.id
             ) t
             where o.site_id = $1 and o.status in ('sent', 'received')
           )
           select s.id, s.name, s.code, s.budget_cents::text as budget_cents,
             labor.hours::numeric(10, 2)::text as labor_hours, labor.cents::bigint::text as labor_cents,
             machines.hours::numeric(10, 2)::text as vehicle_hours,
             machines.cents::bigint::text as vehicle_cents,
             manual.materials::text as materials, manual.rentals::text as rentals,
             manual.subcontract::text as subcontract, manual.other::text as other,
             (labor.missing + machines.missing)::int as missing_rates,
             revenue.cents::text as invoiced, revenue.collected::bigint::text as collected,
             revenue.to_collect::bigint::text as to_collect, certified.cents::bigint::text as certified,
             certified.uninvoiced::bigint::text as certified_uninvoiced,
             certified.retention::bigint::text as retention_held,
             revenue.released::bigint::text as retention_released,
             stock_out.cents::bigint::text as warehouse_cents,
             stock_out.movements as warehouse_movements, stock_out.returns as warehouse_returns,
             stock_out.missing as warehouse_missing,
             orders.count as orders, orders.received as orders_received,
             orders.cents::bigint::text as orders_cents,
             orders.received_cents::bigint::text as orders_received_cents,
             orders.invoiced::bigint::text as orders_invoiced
           from public.sites s, labor, machines, manual, revenue, certified, stock_out, orders
           where s.id = $1`,
          [request.params.site],
        )
        const summary = rows[0]
        return (
          summary && {
            summary,
            revenue: permissions.has('invoices.view'),
            certified: permissions.has('estimates.view'),
            warehouse: permissions.has('warehouse.view'),
            orders: permissions.has('purchases.view'),
          }
        )
      })
      if (!row) throw notFound()
      return reply.send(
        summaryToContract(row.summary, row.revenue, row.certified, row.warehouse, row.orders),
      )
    },
  )
}

function summaryToContract(
  row: SummaryRow,
  withRevenue: boolean,
  withCertified: boolean,
  withWarehouse: boolean,
  withOrders: boolean,
) {
  const parts = [
    row.labor_cents,
    row.vehicle_cents,
    row.materials,
    row.rentals,
    row.subcontract,
    row.other,
  ]
  const total = parts.reduce((sum, cents) => sum + BigInt(cents), 0n)
  const budget = row.budget_cents === null ? null : BigInt(row.budget_cents)
  const remaining = budget === null ? null : budget - total
  const invoiced = BigInt(row.invoiced)
  return {
    site: { id: row.id, name: row.name, code: row.code },
    labor: { hours: row.labor_hours, amount: centsToAmount(row.labor_cents) },
    vehicles: { hours: row.vehicle_hours, amount: centsToAmount(row.vehicle_cents) },
    materials: centsToAmount(row.materials),
    rentals: centsToAmount(row.rentals),
    subcontract: centsToAmount(row.subcontract),
    other: centsToAmount(row.other),
    total: centsToAmount(total.toString()),
    budget: budget === null ? null : centsToAmount(budget.toString()),
    budget_remaining: remaining === null ? null : centsToAmount(remaining.toString()),
    over_budget: remaining !== null && remaining < 0n,
    missing_hourly_costs: row.missing_rates,
    revenue: withRevenue
      ? {
          invoiced: centsToAmount(invoiced.toString()),
          margin: centsToAmount((invoiced - total).toString()),
          collected: centsToAmount(row.collected),
          to_collect: centsToAmount(row.to_collect),
          certified: withCertified ? centsToAmount(row.certified) : null,
          certified_uninvoiced: withCertified ? centsToAmount(row.certified_uninvoiced) : null,
          retention_held: withCertified ? centsToAmount(row.retention_held) : null,
          retention_released: centsToAmount(row.retention_released),
          retention_to_release: withCertified
            ? centsToAmount(String(BigInt(row.retention_held) - BigInt(row.retention_released)))
            : null,
        }
      : null,
    warehouse_materials: withWarehouse
      ? {
          amount: centsToAmount(row.warehouse_cents),
          movements: row.warehouse_movements,
          returns: row.warehouse_returns,
          missing_costs: row.warehouse_missing,
        }
      : null,
    purchase_orders: withOrders
      ? {
          count: row.orders,
          received: row.orders_received,
          total: centsToAmount(row.orders_cents),
          received_total: centsToAmount(row.orders_received_cents),
          invoiced: withRevenue ? centsToAmount(row.orders_invoiced) : null,
        }
      : null,
  }
}

interface MaterialRow {
  id: string
  code: string | null
  name: string
  unit: string
  unloaded: string
  returned: string
  net: string
  cents: string
  missing: number
}

/** Reads the warehouse material of one site, after checking sites.view and warehouse.view. */
async function readSiteMaterials(
  client: PoolClient,
  company: string,
  siteId: string,
): Promise<MaterialRow[]> {
  const permissions = await enterCompany(client, company)
  if (!permissions.has('sites.view')) throw notFound()
  if (!UUID.test(siteId)) throw notFound()
  const site = await client.query('select 1 from public.sites where id = $1', [siteId])
  if (!site.rowCount) throw notFound()
  if (!permissions.has('warehouse.view')) throw forbidden()
  const { rows } = await client.query<MaterialRow>(
    `select i.id, i.code, i.name, i.unit,
       coalesce(sum(m.quantity) filter (where m.kind = 'out'), 0)::numeric(14, 3)::text
         as unloaded,
       coalesce(sum(m.quantity) filter (where m.site_return), 0)::numeric(14, 3)::text
         as returned,
       sum(case when m.kind = 'out' then m.quantity else -m.quantity end)
         ::numeric(14, 3)::text as net,
       coalesce(sum(case when m.kind = 'out' then round(m.quantity * c.average)
         else -round(m.quantity * c.average) end), 0)::bigint::text as cents,
       (count(*) filter (where c.average is null))::int as missing
     from public.warehouse_movements m
     join public.warehouse_items i on i.id = m.item_id
     cross join lateral (
       select sum(l.quantity * l.unit_cost_cents) / nullif(sum(l.quantity), 0) as average
       from public.warehouse_movements l
       where l.item_id = m.item_id and l.kind = 'in' and l.unit_cost_cents is not null
         and l.movement_date <= m.movement_date
     ) c
     where m.site_id = $1 and (m.kind = 'out' or m.site_return)
     group by i.id
     order by i.name, i.id`,
    [siteId],
  )
  return rows
}

const totalCents = (rows: MaterialRow[]) =>
  rows.reduce((sum, r) => sum + BigInt(r.cents), 0n).toString()

/** Warehouse material of one site, item by item: what went there, what came back. */
export function siteWarehouseMaterialRoutes(app: FastifyInstance, db: Db): void {
  const path = '/api/companies/:company/sites/:site/warehouse-materials'
  app.get<{ Params: { company: string; site: string } }>(path, async (request, reply) => {
    const session = requireSession(request)
    const rows = await withIdentity(db.app, { userId: session.user.id }, (client) =>
      readSiteMaterials(client, request.params.company, request.params.site),
    )
    return reply.send({
      data: rows.map((r) => ({
        item: { id: r.id, code: r.code, name: r.name, unit: r.unit },
        unloaded: r.unloaded,
        returned: r.returned,
        net: r.net,
        amount: centsToAmount(r.cents),
        missing_costs: r.missing,
      })),
      amount: centsToAmount(totalCents(rows)),
    })
  })

  app.get<{ Params: { company: string; site: string } }>(
    `${path}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const rows = await withIdentity(db.app, { userId: session.user.id }, (client) =>
        readSiteMaterials(client, request.params.company, request.params.site),
      )
      const comma = (value: string) => value.replace('.', ',')
      const csv = toCsv(
        [
          'Codice',
          'Articolo',
          'Unità',
          'Scaricata',
          'Tornata',
          'Netta',
          'Valore',
          'Movimenti senza costo',
        ],
        [
          ...rows.map((r) => [
            r.code,
            r.name,
            r.unit,
            comma(r.unloaded),
            comma(r.returned),
            comma(r.net),
            italianAmount(r.cents),
            r.missing,
          ]),
          ['Totale', null, null, null, null, null, italianAmount(totalCents(rows)), null],
        ],
      )
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="materiale-cantiere.csv"')
        .send(csv)
    },
  )
}
