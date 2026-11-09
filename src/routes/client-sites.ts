import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { italianAmount, toCsv } from '../csv.js'
import { UUID } from '../deadlines/input.js'
import { forbidden, notFound } from '../http/errors.js'
import { centsToAmount } from '../money.js'
import { requireSession } from '../http/request-context.js'
import { DUE_CENTS, PAID_CENTS, REMAINING_CENTS } from './invoices.js'
import { SITES_ORDER, type SupplierSiteRow } from './site-subcontractors.js'
import { STATUS_LABELS } from './sites.js'

type Request = FastifyRequest<{ Params: { company: string; client: string } }>

interface Row extends SupplierSiteRow {
  quoted: string | null
  invoiced: string
  collected: string
  to_collect: string
}

/**
 * The sites of a client (its own and those with an invoice issued to it), with the taxable
 * amount of the quote the site came from and what was invoiced, collected and left to collect
 * on each, as revenue in the site cost summary but only for the invoices of that client.
 */
export function clientSiteRoutes(app: FastifyInstance, db: Db): void {
  const clientSites = (request: Request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('clients.view')) throw notFound()
      const id = request.params.client
      if (!UUID.test(id)) throw notFound()
      const found = await client.query('select 1 from public.clients where id = $1', [id])
      if (found.rowCount === 0) throw notFound()
      if (!permissions.has('sites.view')) throw forbidden()
      const { rows } = await client.query<Row>(
        `select s.id, s.code, s.name, s.status,
           r.invoiced::bigint::text as invoiced, r.collected::bigint::text as collected,
           r.to_collect::bigint::text as to_collect,
         case when s.quote_id is not null then
           (select coalesce(sum(round(l.quantity * l.unit_price_cents
               * (100 - l.discount_percent) / 100)), 0)::bigint
            from public.quote_lines l where l.quote_id = s.quote_id and l.kind = 'item'
           )::text end as quoted
         from public.sites s
         cross join lateral (
           select coalesce(sum(i.taxable_cents), 0) as invoiced,
             coalesce(sum(case when i.paid_on is not null then ${DUE_CENTS}
               else ${PAID_CENTS} end), 0) as collected,
             coalesce(sum(${REMAINING_CENTS}), 0) as to_collect
           from public.invoices i
           where i.site_id = s.id and i.client_id = $1 and i.direction = 'issued'
         ) r
         where s.client_id = $1
            or exists (select 1 from public.invoices i
                       where i.site_id = s.id and i.client_id = $1 and i.direction = 'issued')
         order by ${SITES_ORDER}`,
        [id],
      )
      return {
        rows,
        amounts: permissions.has('invoices.view'),
        quotes: permissions.has('quotes.view'),
      }
    })
  }

  app.get<{ Params: { company: string; client: string } }>(
    '/api/companies/:company/clients/:client/sites',
    async (request) => {
      const { rows, amounts, quotes } = await clientSites(request)
      return {
        data: rows.map((r) => ({
          site_id: r.id,
          code: r.code,
          name: r.name,
          status: r.status,
          quoted: quotes && r.quoted !== null ? centsToAmount(r.quoted) : null,
          invoiced: amounts ? centsToAmount(r.invoiced) : null,
          collected: amounts ? centsToAmount(r.collected) : null,
          to_collect: amounts ? centsToAmount(r.to_collect) : null,
        })),
      }
    },
  )

  app.get<{ Params: { company: string; client: string } }>(
    '/api/companies/:company/clients/:client/sites/export',
    async (request, reply) => {
      const { rows, amounts, quotes } = await clientSites(request)
      const csv = toCsv(
        [
          'Codice',
          'Cantiere',
          'Stato',
          ...(quotes ? ['Preventivo'] : []),
          ...(amounts ? ['Fatturato', 'Incassato', 'Da incassare'] : []),
        ],
        rows.map((r) => [
          r.code,
          r.name,
          STATUS_LABELS[r.status as keyof typeof STATUS_LABELS],
          ...(quotes ? [r.quoted === null ? null : italianAmount(r.quoted)] : []),
          ...(amounts
            ? [italianAmount(r.invoiced), italianAmount(r.collected), italianAmount(r.to_collect)]
            : []),
        ]),
      )
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="cantieri-cliente.csv"')
        .send(csv)
    },
  )
}
