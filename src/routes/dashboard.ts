import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { requireSession } from '../http/request-context.js'

/**
 * Every cost of a site, one row each: labour and vehicles of approved daily reports at
 * today's hourly cost (as in the site cost summary), plus the costs entered by hand.
 */
const COST_LINES = `
  select r.site_id, r.report_date as day, round(l.hours * coalesce(e.hourly_cost_cents, 0)) as cents
  from public.daily_report_labor l
  join public.daily_reports r on r.id = l.report_id and r.status = 'approved'
  join public.employees e on e.id = l.employee_id
  union all
  select r.site_id, r.report_date, round(v.hours * coalesce(m.hourly_cost_cents, 0))
  from public.daily_report_vehicles v
  join public.daily_reports r on r.id = v.report_id and r.status = 'approved'
  join public.vehicles m on m.id = v.vehicle_id
  union all
  select site_id, cost_date, amount_cents from public.site_costs`

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
        reports: can('reports.view') ? await reportCounts(client, today) : null,
        deadlines: can('deadlines.view') ? await nearDeadlines(client, today) : null,
      }
    })
  })
}
