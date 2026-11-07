import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { MAX_EXPORT_ROWS, italianAmount, italianDate, toCsv } from '../csv.js'
import { ValidationFailed, forbidden, notFound, type FieldErrors } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import type { Permission } from '../permissions.js'
import { accountPdf } from '../accounts/pdf.js'
import { DUE_CENTS, PAID_CENTS, REMAINING_CENTS } from './invoices.js'
import { readLogoForPdf } from './logo.js'
import { readProfile } from './settings.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Subject {
  /** Path segment and route parameter. */
  path: 'clients' | 'suppliers'
  param: 'client' | 'supplier'
  table: 'public.clients' | 'public.suppliers'
  column: 'client_id' | 'supplier_id'
  direction: 'issued' | 'received'
  view: Permission
}

const SUBJECTS: Subject[] = [
  {
    path: 'clients',
    param: 'client',
    table: 'public.clients',
    column: 'client_id',
    direction: 'issued',
    view: 'clients.view',
  },
  {
    path: 'suppliers',
    param: 'supplier',
    table: 'public.suppliers',
    column: 'supplier_id',
    direction: 'received',
    view: 'suppliers.view',
  },
]

interface AccountRow {
  invoice_count: number
  open_invoice_count: number
  total: string
  amount_due: string
  outstanding: string
  overdue: string
}

const TODAY = "(now() at time zone 'Europe/Rome')::date"

/**
 * Checks the permissions and that the subject exists in the company: without the permission
 * on the subject it is "not found", as in its card; without invoices.view it is 403.
 */
async function enterSubject(
  client: PoolClient,
  subject: Subject,
  params: Record<string, string>,
): Promise<string> {
  const permissions = await enterCompany(client, params.company ?? '')
  if (!permissions.has(subject.view)) throw notFound()
  const id = params[subject.param] ?? ''
  if (!UUID.test(id)) throw notFound()
  const found = await client.query(`select 1 from ${subject.table} where id = $1`, [id])
  if (!found.rowCount) throw notFound()
  if (!permissions.has('invoices.view')) throw forbidden()
  return id
}

interface BalanceRow {
  id: string | null
  name: string
  open_invoice_count: number
  outstanding: string
  overdue: string
  oldest_due_date: string | null
  total_count: number
  total_outstanding: string
  total_overdue: string
}

/**
 * Open balance of each subject, highest first: $1 direction, $2 limit, $3 offset, $4 only
 * those with something overdue. A single row with a null id when the page is empty.
 */
const balancesSql = (subject: Subject) =>
  `with open as (
     select i.${subject.column} as subject_id, (${REMAINING_CENTS}) as remaining,
       i.due_date, i.due_date < ${TODAY} as late
     from public.invoices i
     where i.direction = $1 and i.paid_on is null and i.${subject.column} is not null
   ), balances as (
     select o.subject_id, count(*)::int as open_invoice_count,
       sum(o.remaining) as outstanding,
       coalesce(sum(o.remaining) filter (where o.late), 0) as overdue,
       min(o.due_date)::text as oldest_due_date
     from open o where o.remaining > 0
     group by o.subject_id
   ), chosen as (
     select b.*, x.name from balances b
     join ${subject.table} x on x.id = b.subject_id
     where not $4::boolean or b.overdue > 0
   ), page as (
     select * from chosen
     order by outstanding desc, name asc, subject_id asc
     limit $2 offset $3
   ), totals as (
     select count(*)::int as total_count,
       coalesce(sum(outstanding), 0)::text as total_outstanding,
       coalesce(sum(overdue), 0)::text as total_overdue
     from chosen
   )
   -- One row even past the last page, so the totals are always there.
   select p.subject_id as id, p.name, p.open_invoice_count,
     p.outstanding::text as outstanding, p.overdue::text as overdue, p.oldest_due_date,
     t.total_count, t.total_outstanding, t.total_overdue
   from totals t left join page p on true
   order by p.outstanding desc, p.name asc, p.subject_id asc`

/** filter[overdue]=true: only the subjects with something overdue. */
function readOverdueFilter(query: Record<string, unknown>): boolean {
  const value = query['filter[overdue]']
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new ValidationFailed({ 'filter[overdue]': ['Valori ammessi: true, false.'] })
}

/** page and per_page of a list, as in the other lists. */
function readPaging(query: Record<string, unknown>): { page: number; perPage: number } {
  const errors: FieldErrors = {}
  const integer = (name: string, fallback: number, max?: number): number => {
    const value = query[name]
    if (value === undefined) return fallback
    const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : NaN
    if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
      errors[name] = [max ? `Un numero intero da 1 a ${max}.` : 'Un numero intero da 1 in su.']
      return fallback
    }
    return n
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage }
}

/** Statement of account of a client (issued invoices) or a supplier (received invoices). */
export function accountRoutes(app: FastifyInstance, db: Db): void {
  for (const subject of SUBJECTS) {
    app.get<{ Params: Record<string, string> }>(
      `/api/companies/:company/${subject.path}/:${subject.param}/account`,
      async (request) => {
        const session = requireSession(request)
        return withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const id = await enterSubject(client, subject, request.params)
          const { rows } = await client.query<AccountRow>(
            `select count(*)::int as invoice_count,
               (count(*) filter (where i.paid_on is null))::int as open_invoice_count,
               coalesce(sum(i.taxable_cents + i.vat_cents), 0)::text as total,
               coalesce(sum(${DUE_CENTS}), 0)::text as amount_due,
               coalesce(sum(${REMAINING_CENTS}), 0)::text as outstanding,
               coalesce(sum(${REMAINING_CENTS}) filter (where i.paid_on is null
                 and i.due_date < ${TODAY}), 0)::text as overdue
             from public.invoices i
             where i.${subject.column} = $1 and i.direction = $2`,
            [id, subject.direction],
          )
          const r = rows[0]
          if (!r) throw notFound()
          return {
            invoice_count: r.invoice_count,
            open_invoice_count: r.open_invoice_count,
            total: centsToAmount(r.total),
            amount_due: centsToAmount(r.amount_due),
            settled: centsToAmount((BigInt(r.amount_due) - BigInt(r.outstanding)).toString()),
            outstanding: centsToAmount(r.outstanding),
            overdue: centsToAmount(r.overdue),
          }
        })
      },
    )
  }

  for (const subject of SUBJECTS) {
    app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
      `/api/companies/:company/${subject.path}/balances`,
      async (request) => {
        const session = requireSession(request)
        const { page, perPage } = readPaging(request.query)
        const overdueOnly = readOverdueFilter(request.query)
        return withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has(subject.view) || !permissions.has('invoices.view')) {
            throw forbidden()
          }
          const { rows } = await client.query<BalanceRow>(balancesSql(subject), [
            subject.direction,
            perPage,
            (page - 1) * perPage,
            overdueOnly,
          ])
          const totals = rows[0]
          const pageRows = rows.filter((r): r is BalanceRow & { id: string } => r.id !== null)
          return {
            data: pageRows.map((r) => ({
              subject: { id: r.id, name: r.name },
              open_invoice_count: r.open_invoice_count,
              outstanding: centsToAmount(r.outstanding),
              overdue: centsToAmount(r.overdue),
              oldest_due_date: r.oldest_due_date,
            })),
            meta: { total: totals?.total_count ?? 0, page, per_page: perPage },
            outstanding: centsToAmount(totals?.total_outstanding ?? '0'),
            overdue: centsToAmount(totals?.total_overdue ?? '0'),
          }
        })
      },
    )
  }

  for (const subject of SUBJECTS) {
    app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
      `/api/companies/:company/${subject.path}/balances/export`,
      async (request, reply) => {
        const session = requireSession(request)
        const overdueOnly = readOverdueFilter(request.query)
        const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has(subject.view) || !permissions.has('invoices.view')) {
            throw forbidden()
          }
          const { rows } = await client.query<BalanceRow>(balancesSql(subject), [
            subject.direction,
            MAX_EXPORT_ROWS,
            0,
            overdueOnly,
          ])
          const balances = rows.filter((r) => r.id !== null)
          return toCsv(
            [
              subject.param === 'client' ? 'Cliente' : 'Fornitore',
              'Fatture aperte',
              'Scadenza più vecchia',
              subject.param === 'client' ? 'Da incassare' : 'Da pagare',
              'Di cui scaduto',
            ],
            balances.map((r) => [
              r.name,
              r.open_invoice_count,
              r.oldest_due_date === null ? null : italianDate(r.oldest_due_date),
              italianAmount(r.outstanding),
              italianAmount(r.overdue),
            ]),
          )
        })
        const file = subject.param === 'client' ? 'crediti-clienti.csv' : 'debiti-fornitori.csv'
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${file}"`)
          .send(csv)
      },
    )
  }

  const clients = SUBJECTS[0]
  if (!clients) return
  app.get<{ Params: Record<string, string> }>(
    '/api/companies/:company/clients/:client/account/pdf',
    async (request, reply) => {
      const session = requireSession(request)
      const buffer = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const id = await enterSubject(client, clients, request.params)
        const subject = await client.query<{
          name: string
          vat_number: string | null
          tax_code: string | null
          street: string | null
          postal_code: string | null
          city: string | null
          province: string | null
          today: string
        }>(
          `select name, vat_number, tax_code, street, postal_code, city, province,
             ${TODAY}::text as today
           from public.clients where id = $1`,
          [id],
        )
        const row = subject.rows[0]
        if (!row) throw notFound()
        const { today, ...clientData } = row
        const { rows } = await client.query<{
          number: string
          date: string
          due_date: string | null
          overdue: boolean
          due_cents: string
          remaining_cents: string
        }>(
          `select i.number, i.invoice_date::text as date, i.due_date::text as due_date,
             coalesce(i.due_date < ${TODAY}, false) as overdue,
             (${DUE_CENTS})::text as due_cents, (${REMAINING_CENTS})::text as remaining_cents
           from public.invoices i
           where i.client_id = $1 and i.direction = 'issued' and i.paid_on is null
             and ${DUE_CENTS} - ${PAID_CENTS} > 0
           order by i.due_date asc nulls last, i.invoice_date asc, i.number asc`,
          [id],
        )
        let outstanding = 0n
        let overdue = 0n
        for (const r of rows) {
          outstanding += BigInt(r.remaining_cents)
          if (r.overdue) overdue += BigInt(r.remaining_cents)
        }
        const profile = await readProfile(client)
        return accountPdf({
          logo: await readLogoForPdf(client),
          company: {
            ...profile,
            share_capital:
              profile.share_capital_cents === null
                ? null
                : centsToAmount(profile.share_capital_cents),
          },
          client: clientData,
          today,
          outstanding: centsToAmount(outstanding.toString()),
          overdue: centsToAmount(overdue.toString()),
          invoices: rows.map((r) => ({
            number: r.number,
            date: r.date,
            due_date: r.due_date,
            overdue: r.overdue,
            amount_due: centsToAmount(r.due_cents),
            settled: centsToAmount((BigInt(r.due_cents) - BigInt(r.remaining_cents)).toString()),
            remaining: centsToAmount(r.remaining_cents),
          })),
        })
      })
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="estratto-conto.pdf"')
        .header('Cache-Control', 'private, no-store')
        .send(buffer)
    },
  )
}
