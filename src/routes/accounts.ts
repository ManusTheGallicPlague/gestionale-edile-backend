import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { forbidden, notFound } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import type { Permission } from '../permissions.js'
import { DUE_CENTS, REMAINING_CENTS } from './invoices.js'

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

/** Statement of account of a client (issued invoices) or a supplier (received invoices). */
export function accountRoutes(app: FastifyInstance, db: Db): void {
  for (const subject of SUBJECTS) {
    app.get<{ Params: Record<string, string> }>(
      `/api/companies/:company/${subject.path}/:${subject.param}/account`,
      async (request) => {
        const session = requireSession(request)
        return withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company ?? '')
          // Without the permission on the subject it is "not found", as in its card.
          if (!permissions.has(subject.view)) throw notFound()
          const id = request.params[subject.param] ?? ''
          if (!UUID.test(id)) throw notFound()
          const found = await client.query(`select 1 from ${subject.table} where id = $1`, [id])
          if (!found.rowCount) throw notFound()
          if (!permissions.has('invoices.view')) throw forbidden()
          // "Today" is the Italian one, not the server's.
          const { rows } = await client.query<AccountRow>(
            `select count(*)::int as invoice_count,
               (count(*) filter (where i.paid_on is null))::int as open_invoice_count,
               coalesce(sum(i.taxable_cents + i.vat_cents), 0)::text as total,
               coalesce(sum(${DUE_CENTS}), 0)::text as amount_due,
               coalesce(sum(${REMAINING_CENTS}), 0)::text as outstanding,
               coalesce(sum(${REMAINING_CENTS}) filter (where i.paid_on is null
                 and i.due_date < (now() at time zone 'Europe/Rome')::date), 0)::text as overdue
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
}
