import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { requireSession } from '../http/request-context.js'
import { REMAINING_CENTS } from './invoices.js'
import { statementTotals } from './progress-statements.js'
import { FOLLOW_UPS as ORDER_FOLLOW_UPS } from './purchase-orders.js'
import { FOLLOW_UPS } from './quotes.js'
import { BELOW_MIN } from './warehouse.js'

/**
 * Every cost of a site, one row each: labour and vehicles of approved daily reports at
 * today's hourly cost (as in the site cost summary), plus the costs entered by hand.
 */
const COST_LINES = `
  select r.site_id, r.report_date as day, round(l.hours * coalesce(e.hourly_cost_cents, 0)) as cents,
    'labor' as kind
  from public.daily_report_labor l
  join public.daily_reports r on r.id = l.report_id and r.status = 'approved'
  join public.employees e on e.id = l.employee_id
  union all
  select r.site_id, r.report_date, round(v.hours * coalesce(m.hourly_cost_cents, 0)), 'vehicles'
  from public.daily_report_vehicles v
  join public.daily_reports r on r.id = v.report_id and r.status = 'approved'
  join public.vehicles m on m.id = v.vehicle_id
  union all
  select site_id, cost_date, amount_cents, 'other' from public.site_costs`

async function siteCounts(client: PoolClient) {
  const { rows } = await client.query<{ status: string; n: number }>(
    'select status, count(*)::int as n from public.sites group by status',
  )
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0
  return {
    planned: count('planned'),
    active: count('active'),
    suspended: count('suspended'),
    completed: count('completed'),
  }
}

async function overBudget(client: PoolClient) {
  const { rows } = await client.query<{
    id: string
    name: string
    code: string | null
    budget: string
    total: string
    overrun: string
  }>(
    `with costs as (
       select site_id, sum(cents) as cents from (${COST_LINES}) x group by site_id
     )
     select s.id, s.name, s.code, s.budget_cents::text as budget, c.cents::bigint::text as total,
       (c.cents - s.budget_cents)::bigint::text as overrun
     from public.sites s
     join costs c on c.site_id = s.id
     where s.status <> 'completed' and s.budget_cents is not null and c.cents > s.budget_cents
     order by c.cents - s.budget_cents desc, s.id
     limit 10`,
  )
  return rows.map((r) => ({
    site: { id: r.id, name: r.name, code: r.code },
    budget: centsToAmount(r.budget),
    total: centsToAmount(r.total),
    overrun: centsToAmount(r.overrun),
  }))
}

async function costsThisMonth(client: PoolClient, today: string) {
  const { rows } = await client.query<{ total: string }>(
    `select coalesce(sum(cents), 0)::bigint::text as total from (${COST_LINES}) x
     where day >= date_trunc('month', $1::date) and day < date_trunc('month', $1::date) + interval '1 month'`,
    [today],
  )
  return { month: today.slice(0, 7), total: centsToAmount(rows[0]?.total ?? '0') }
}

/** The last 12 months, this one included, oldest first, months without costs at zero. */
async function costsByMonth(client: PoolClient, today: string) {
  const { rows } = await client.query<{
    month: string
    labor: string
    vehicles: string
    other: string
    total: string
  }>(
    `with months as (
       select generate_series(date_trunc('month', $1::date) - interval '11 months',
         date_trunc('month', $1::date), interval '1 month')::date as month
     )
     select to_char(m.month, 'YYYY-MM') as month,
       coalesce(sum(x.cents) filter (where x.kind = 'labor'), 0)::bigint::text as labor,
       coalesce(sum(x.cents) filter (where x.kind = 'vehicles'), 0)::bigint::text as vehicles,
       coalesce(sum(x.cents) filter (where x.kind = 'other'), 0)::bigint::text as other,
       coalesce(sum(x.cents), 0)::bigint::text as total
     from months m
     left join (${COST_LINES}) x
       on x.day >= m.month and x.day < m.month + interval '1 month'
     group by m.month
     order by m.month`,
    [today],
  )
  return rows.map((r) => ({
    month: r.month,
    labor: centsToAmount(r.labor),
    vehicles: centsToAmount(r.vehicles),
    other: centsToAmount(r.other),
    total: centsToAmount(r.total),
  }))
}

/**
 * Active sites with a schedule: progress of the activities weighted by their length in days,
 * against the share of those days already gone by today. Most behind first.
 */
async function siteProgress(client: PoolClient, today: string) {
  const { rows } = await client.query<{
    id: string
    name: string
    code: string | null
    activities: number
    progress: number
    planned: number
  }>(
    `with a as (
       select site_id, progress, (end_on - start_on + 1) as days,
         greatest(0, least(end_on, $1::date) - start_on + 1) as elapsed
       from public.site_activities
     ), p as (
       select site_id, count(*)::int as activities,
         round(sum(progress * days)::numeric / sum(days))::int as progress,
         round(100 * sum(elapsed)::numeric / sum(days))::int as planned
       from a group by site_id
     )
     select s.id, s.name, s.code, p.activities, p.progress, p.planned
     from public.sites s
     join p on p.site_id = s.id
     where s.status = 'active'
     order by p.planned - p.progress desc, s.name, s.id
     limit 10`,
    [today],
  )
  return rows.map((r) => ({
    site: { id: r.id, name: r.name, code: r.code },
    activities: r.activities,
    progress: r.progress,
    planned: r.planned,
  }))
}

async function reportCounts(client: PoolClient, today: string) {
  const { rows } = await client.query<{ to_approve: number; drafts: number }>(
    `select count(*) filter (where status = 'submitted')::int as to_approve,
       count(*) filter (where status = 'draft' and report_date < $1::date)::int as drafts
     from public.daily_reports`,
    [today],
  )
  return { to_approve: rows[0]?.to_approve ?? 0, drafts: rows[0]?.drafts ?? 0 }
}

async function nearDeadlines(client: PoolClient, today: string) {
  const { rows } = await client.query<{
    id: string
    title: string
    due_on: string
    kind: string
    amount_cents: string | null
  }>(
    `select id, title, due_on::text as due_on, kind, amount_cents::text as amount_cents
     from public.deadlines
     where status = 'open' and due_on <= $1::date + 7
     order by due_on, id
     limit 10`,
    [today],
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    due_on: r.due_on,
    kind: r.kind,
    amount: r.amount_cents === null ? null : centsToAmount(r.amount_cents),
    overdue: r.due_on < today,
  }))
}

/** Unpaid invoices by amount due, issued (receivable) and received (payable). */
async function invoiceTotals(client: PoolClient, today: string) {
  const { rows } = await client.query<{
    receivable: string
    receivable_overdue: string
    payable: string
    payable_overdue: string
  }>(
    `select
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'issued'), 0)::text as receivable,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'issued' and i.due_date < $1::date),
         0)::text as receivable_overdue,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'received'), 0)::text as payable,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'received'
         and i.due_date < $1::date), 0)::text as payable_overdue
     from public.invoices i where i.paid_on is null`,
    [today],
  )
  const r = rows[0]
  return {
    receivable: centsToAmount(r?.receivable ?? '0'),
    receivable_overdue: centsToAmount(r?.receivable_overdue ?? '0'),
    payable: centsToAmount(r?.payable ?? '0'),
    payable_overdue: centsToAmount(r?.payable_overdue ?? '0'),
  }
}

/**
 * Quotes to follow up, with the same conditions as filter[follow_up] in the quote list; the
 * taxable amount rounds each line as the quote totals do, then sums them.
 */
async function quoteTotals(client: PoolClient) {
  const { rows } = await client.query<{
    drafts: number
    awaiting: number
    taxable: string
    expiring: number
    past_validity: number
    accepted_without_site: number
  }>(
    `select count(*) filter (where q.status = 'draft')::int as drafts,
       count(*) filter (where ${FOLLOW_UPS.awaiting})::int as awaiting,
       coalesce(sum((select sum(round(l.quantity * l.unit_price_cents
           * (100 - l.discount_percent) / 100))
         from public.quote_lines l where l.quote_id = q.id and l.kind = 'item'))
         filter (where ${FOLLOW_UPS.awaiting}), 0)::bigint::text as taxable,
       count(*) filter (where ${FOLLOW_UPS.expiring})::int as expiring,
       count(*) filter (where ${FOLLOW_UPS.past_validity})::int as past_validity,
       count(*) filter (where ${FOLLOW_UPS.accepted_without_site})::int as accepted_without_site
     from public.quotes q`,
  )
  const r = rows[0]
  return {
    drafts: r?.drafts ?? 0,
    awaiting: r?.awaiting ?? 0,
    awaiting_taxable: centsToAmount(r?.taxable ?? '0'),
    expiring: r?.expiring ?? 0,
    past_validity: r?.past_validity ?? 0,
    accepted_without_site: r?.accepted_without_site ?? 0,
  }
}

/**
 * Purchase orders to follow up, with the same conditions as filter[follow_up] in the order
 * list; the total rounds each line as the order totals do, then sums them.
 */
async function purchaseOrderTotals(client: PoolClient) {
  const { rows } = await client.query<{
    drafts: number
    awaiting: number
    total: string
    late: number
    due_soon: number
  }>(
    `select count(*) filter (where o.status = 'draft')::int as drafts,
       count(*) filter (where ${ORDER_FOLLOW_UPS.awaiting})::int as awaiting,
       coalesce(sum((select sum(round(l.quantity * l.unit_price_cents))
         from public.purchase_order_lines l where l.order_id = o.id))
         filter (where ${ORDER_FOLLOW_UPS.awaiting}), 0)::bigint::text as total,
       count(*) filter (where ${ORDER_FOLLOW_UPS.late})::int as late,
       count(*) filter (where ${ORDER_FOLLOW_UPS.due_soon})::int as due_soon
     from public.purchase_orders o`,
  )
  const r = rows[0]
  return {
    drafts: r?.drafts ?? 0,
    awaiting: r?.awaiting ?? 0,
    awaiting_total: centsToAmount(r?.total ?? '0'),
    late: r?.late ?? 0,
    due_soon: r?.due_soon ?? 0,
  }
}

/** Warehouse items to reorder: with a minimum stock and the stock under it. */
async function warehouseCounts(client: PoolClient) {
  const { rows } = await client.query<{ below_min: number }>(
    `select count(*)::int as below_min from public.warehouse_items i where ${BELOW_MIN}`,
  )
  return { below_min: rows[0]?.below_min ?? 0 }
}

/** The company dashboard: each section only for those who may see its data. */
export function dashboardRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { company: string } }>('/api/companies/:company/dashboard', async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      const { rows } = await client.query<{ today: string }>(
        "select (now() at time zone 'Europe/Rome')::date::text as today",
      )
      const today = rows[0]?.today ?? ''
      const can = (p: Parameters<typeof permissions.has>[0]) => permissions.has(p)
      return {
        today,
        sites: can('sites.view') ? await siteCounts(client) : null,
        over_budget: can('sites.view') && can('costs.view') ? await overBudget(client) : null,
        costs_this_month: can('costs.view') ? await costsThisMonth(client, today) : null,
        costs_by_month: can('costs.view') ? await costsByMonth(client, today) : null,
        site_progress: can('sites.view') ? await siteProgress(client, today) : null,
        reports: can('reports.view') ? await reportCounts(client, today) : null,
        deadlines: can('deadlines.view') ? await nearDeadlines(client, today) : null,
        invoices: can('invoices.view') ? await invoiceTotals(client, today) : null,
        progress_statements: can('estimates.view') ? await statementTotals(client) : null,
        quotes: can('quotes.view') ? await quoteTotals(client) : null,
        purchase_orders: can('purchases.view') ? await purchaseOrderTotals(client) : null,
        warehouse: can('warehouse.view') ? await warehouseCounts(client) : null,
      }
    })
  })
}
