import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { forbidden, notFound } from '../http/errors.js'
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
