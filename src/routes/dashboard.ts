import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { requireSession } from '../http/request-context.js'
import { REMAINING_CENTS, SETTLED, SIGNED_TAXABLE } from './invoices.js'
import { currentVat } from './vat-summary.js'
import { statementTotals } from './progress-statements.js'
import { FOLLOW_UPS as ORDER_FOLLOW_UPS } from './purchase-orders.js'
import { FOLLOW_UPS } from './quotes.js'
import { ACTIVITY_FOLLOW_UPS } from './site-activities.js'
import { onSite } from './site-subcontractors.js'
import { teamHas } from './site-team.js'
import { COMPLIANCE_SQL } from './suppliers.js'
import { BELOW_MIN, stockValueCents } from './warehouse.js'
import { DOCUMENTS_SQL } from './vehicles.js'
import { EMPLOYEE_DOCUMENTS_SQL } from './employees.js'
import { readTotals } from './absence-totals.js'
import { COST_LINES } from './site-costs.js'

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

async function reportCounts(client: PoolClient, today: string, withSites: boolean) {
  const { rows } = await client.query<{ to_approve: number; drafts: number }>(
    `select count(*) filter (where status = 'submitted')::int as to_approve,
       count(*) filter (where status = 'draft' and report_date < $1::date)::int as drafts
     from public.daily_reports`,
    [today],
  )
  return {
    to_approve: rows[0]?.to_approve ?? 0,
    drafts: rows[0]?.drafts ?? 0,
    missing_today: withSites ? await sitesWithoutReport(client, today) : null,
  }
}

/** Active sites with no daily report (in any status) dated today. */
async function sitesWithoutReport(client: PoolClient, today: string) {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n
     from public.sites s
     where s.status = 'active'
       and not exists (
         select 1 from public.daily_reports r where r.site_id = s.id and r.report_date = $1::date
       )`,
    [today],
  )
  return rows[0]?.n ?? 0
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
    without_order: number
    without_order_amount: string
  }>(
    `select
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'issued'), 0)::text as receivable,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'issued' and i.due_date < $1::date),
         0)::text as receivable_overdue,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'received'), 0)::text as payable,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'received'
         and i.due_date < $1::date), 0)::text as payable_overdue,
       count(*) filter (where i.direction = 'received' and i.purchase_order_id is null)::int
         as without_order,
       coalesce(sum(${REMAINING_CENTS}) filter (where i.direction = 'received'
         and i.purchase_order_id is null), 0)::text as without_order_amount
     from public.invoices i where not ${SETTLED}`,
    [today],
  )
  const r = rows[0]
  return {
    receivable: centsToAmount(r?.receivable ?? '0'),
    receivable_overdue: centsToAmount(r?.receivable_overdue ?? '0'),
    payable: centsToAmount(r?.payable ?? '0'),
    payable_overdue: centsToAmount(r?.payable_overdue ?? '0'),
    payable_without_order: r?.without_order ?? 0,
    payable_without_order_amount: centsToAmount(r?.without_order_amount ?? '0'),
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
async function purchaseOrderTotals(client: PoolClient, seesInvoices: boolean) {
  const orderTotal = `(select sum(round(l.quantity * l.unit_price_cents))
         from public.purchase_order_lines l where l.order_id = o.id)`
  // The same orders as filter[status]=received with filter[invoiced]=false in the list.
  const uninvoiced = `o.status = 'received'
         and not exists (select 1 from public.invoices i where i.purchase_order_id = o.id)`
  const { rows } = await client.query<{
    drafts: number
    awaiting: number
    total: string
    late: number
    due_soon: number
    uninvoiced: number
    uninvoiced_total: string
    over_invoiced: number
  }>(
    `select count(*) filter (where o.status = 'draft')::int as drafts,
       count(*) filter (where ${ORDER_FOLLOW_UPS.awaiting})::int as awaiting,
       coalesce(sum(${orderTotal}) filter (where ${ORDER_FOLLOW_UPS.awaiting}), 0)::bigint::text
         as total,
       count(*) filter (where ${ORDER_FOLLOW_UPS.late})::int as late,
       count(*) filter (where ${ORDER_FOLLOW_UPS.due_soon})::int as due_soon,
       count(*) filter (where ${uninvoiced})::int as uninvoiced,
       coalesce(sum(${orderTotal}) filter (where ${uninvoiced}), 0)::bigint::text
         as uninvoiced_total,
       count(*) filter (where (select coalesce(sum(${SIGNED_TAXABLE}), 0) from public.invoices i
         where i.purchase_order_id = o.id) > coalesce(${orderTotal}, 0))::int as over_invoiced
     from public.purchase_orders o`,
  )
  const r = rows[0]
  return {
    drafts: r?.drafts ?? 0,
    awaiting: r?.awaiting ?? 0,
    awaiting_total: centsToAmount(r?.total ?? '0'),
    late: r?.late ?? 0,
    due_soon: r?.due_soon ?? 0,
    // Whether an order has an invoice tells about invoices: only who sees them sees it.
    received_uninvoiced: seesInvoices ? (r?.uninvoiced ?? 0) : null,
    received_uninvoiced_total: seesInvoices ? centsToAmount(r?.uninvoiced_total ?? '0') : null,
    over_invoiced: seesInvoices ? (r?.over_invoiced ?? 0) : null,
  }
}

/** Warehouse items to reorder: with a minimum stock and the stock under it. */
async function warehouseCounts(client: PoolClient) {
  const { rows } = await client.query<{ below_min: number }>(
    `select count(*)::int as below_min from public.warehouse_items i where ${BELOW_MIN}`,
  )
  return {
    below_min: rows[0]?.below_min ?? 0,
    stock_value: centsToAmount(await stockValueCents(client)),
  }
}

/**
 * Active (not archived) subcontractors to check before they enter a site, with the same
 * conditions as filter[compliance] in the supplier list.
 */
async function subcontractorCounts(client: PoolClient, sites: boolean) {
  type Counts = {
    expired: number
    expiring: number
    no_valid_durc: number
    no_valid_credit_license: number
  }
  const { rows } = await client.query<Counts>(
    `select count(*) filter (where ${COMPLIANCE_SQL.expired})::int as expired,
       count(*) filter (where ${COMPLIANCE_SQL.expiring})::int as expiring,
       count(*) filter (where ${COMPLIANCE_SQL.no_valid_durc})::int as no_valid_durc,
       count(*) filter (where ${COMPLIANCE_SQL.no_valid_credit_license})::int
         as no_valid_credit_license
     from public.suppliers
     where subcontractor and archived_at is null`,
  )
  // Active sites with a subcontractor on them (archived ones too) to check, as
  // filter[subcontractor_compliance] with filter[status]=active in listSites.
  const onActiveSites = async () => {
    const irregular = (state: 'expired' | 'no_valid_durc' | 'no_valid_credit_license') =>
      `count(*) filter (where exists (select 1 from public.suppliers
         where ${onSite('s.id')} and ${COMPLIANCE_SQL[state]}))::int`
    const result = await client.query<Omit<Counts, 'expiring'>>(
      `select ${irregular('expired')} as expired, ${irregular('no_valid_durc')} as no_valid_durc,
         ${irregular('no_valid_credit_license')} as no_valid_credit_license
       from public.sites s where s.status = 'active'`,
    )
    return result.rows[0]
  }
  const active = sites ? await onActiveSites() : undefined
  return {
    expired: rows[0]?.expired ?? 0,
    expiring: rows[0]?.expiring ?? 0,
    no_valid_durc: rows[0]?.no_valid_durc ?? 0,
    no_valid_credit_license: rows[0]?.no_valid_credit_license ?? 0,
    active_sites_expired: sites ? (active?.expired ?? 0) : null,
    active_sites_no_valid_durc: sites ? (active?.no_valid_durc ?? 0) : null,
    active_sites_no_valid_credit_license: sites ? (active?.no_valid_credit_license ?? 0) : null,
  }
}

/** The open deadlines of the next maintenances of the vehicle aliased `v`. */
const MAINTENANCE_DUE = `select 1 from public.deadlines d
  where d.vehicle_id = v.id and d.vehicle_maintenance_id is not null and d.status = 'open'`

/**
 * Active vehicles to check: documents to renew, as filter[documents] in the vehicle list, and
 * next maintenances past or near.
 */
async function vehicleCounts(client: PoolClient, today: string) {
  const { rows } = await client.query<{
    expired: number
    expiring: number
    overdue: number
    due_soon: number
  }>(
    `select count(*) filter (where ${DOCUMENTS_SQL.expired})::int as expired,
       count(*) filter (where ${DOCUMENTS_SQL.expiring})::int as expiring,
       count(*) filter (where exists (${MAINTENANCE_DUE} and d.due_on < $1::date))::int
         as overdue,
       count(*) filter (where not exists (${MAINTENANCE_DUE} and d.due_on < $1::date)
         and exists (${MAINTENANCE_DUE} and d.due_on <= $1::date + 30))::int as due_soon
     from public.vehicles v
     where v.active`,
    [today],
  )
  return {
    documents_expired: rows[0]?.expired ?? 0,
    documents_expiring: rows[0]?.expiring ?? 0,
    maintenance_overdue: rows[0]?.overdue ?? 0,
    maintenance_due_soon: rows[0]?.due_soon ?? 0,
  }
}

/**
 * Active employees with documents to renew, as filter[documents] in the employee list, and
 * active sites whose team has one expired, as filter[team_documents] in the site list.
 */
async function employeeCounts(client: PoolClient, sites: boolean) {
  const { rows } = await client.query<{ expired: number; expiring: number }>(
    `select count(*) filter (where ${EMPLOYEE_DOCUMENTS_SQL.expired})::int as expired,
       count(*) filter (where ${EMPLOYEE_DOCUMENTS_SQL.expiring})::int as expiring
     from public.employees e
     where e.active`,
  )
  let activeSitesExpired: number | null = null
  if (sites) {
    const active = await client.query<{ n: number }>(
      `select count(*)::int as n from public.sites s
       where s.status = 'active' and ${teamHas('s.id', EMPLOYEE_DOCUMENTS_SQL.expired)}`,
    )
    activeSitesExpired = active.rows[0]?.n ?? 0
  }
  return {
    documents_expired: rows[0]?.expired ?? 0,
    documents_expiring: rows[0]?.expiring ?? 0,
    active_sites_expired: activeSitesExpired,
  }
}

/** Schedule activities to follow, as filter[follow_up] in the company activity list. */
async function activityCounts(client: PoolClient) {
  const { rows } = await client.query<{ late: number; starting_soon: number }>(
    `select count(*) filter (where ${ACTIVITY_FOLLOW_UPS.late})::int as late,
       count(*) filter (where ${ACTIVITY_FOLLOW_UPS.starting_soon})::int as starting_soon
     from public.site_activities a`,
  )
  return { late: rows[0]?.late ?? 0, starting_soon: rows[0]?.starting_soon ?? 0 }
}

/** Absences of the active employees: who is away today, and who will be in the next week. */
async function absenceCounts(client: PoolClient, today: string) {
  const { rows } = await client.query<{ away_today: number; starting_soon: number }>(
    `select count(distinct a.employee_id)
         filter (where a.starts_on <= $1::date and a.ends_on >= $1::date)::int as away_today,
       count(*) filter (where a.starts_on > $1::date and a.starts_on <= $1::date + 7)::int
         as starting_soon
     from public.employee_absences a
     join public.employees e on e.id = a.employee_id and e.active`,
    [today],
  )
  const year = await readTotals(client, { year: today.slice(0, 4) })
  const active = year.employees.filter((e) => e.employee.active)
  return {
    away_today: rows[0]?.away_today ?? 0,
    starting_soon: rows[0]?.starting_soon ?? 0,
    vacation_exceeded: active.filter(
      (e) => e.vacation_remaining !== null && e.vacation_remaining < 0,
    ).length,
    permit_exceeded: active.filter((e) => e.permit_remaining?.startsWith('-') ?? false).length,
  }
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
        reports: can('reports.view') ? await reportCounts(client, today, can('sites.view')) : null,
        deadlines: can('deadlines.view') ? await nearDeadlines(client, today) : null,
        invoices: can('invoices.view') ? await invoiceTotals(client, today) : null,
        progress_statements: can('estimates.view') ? await statementTotals(client) : null,
        quotes: can('quotes.view') ? await quoteTotals(client) : null,
        purchase_orders: can('purchases.view')
          ? await purchaseOrderTotals(client, can('invoices.view'))
          : null,
        warehouse: can('warehouse.view') ? await warehouseCounts(client) : null,
        subcontractors: can('suppliers.view')
          ? await subcontractorCounts(client, can('sites.view'))
          : null,
        vehicles: can('vehicles.view') ? await vehicleCounts(client, today) : null,
        employees: can('employees.view') ? await employeeCounts(client, can('sites.view')) : null,
        activities: can('sites.view') ? await activityCounts(client) : null,
        absences: can('employees.view') ? await absenceCounts(client, today) : null,
        vat: can('invoices.view') ? await currentVat(client, today) : null,
      }
    })
  })
}
