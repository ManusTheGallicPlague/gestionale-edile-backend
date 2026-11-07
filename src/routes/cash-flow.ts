import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { ValidationFailed, forbidden } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { REMAINING_CENTS } from './invoices.js'

const MAX_MONTHS = 24

/** months: 1 to 24, 6 if missing. */
function readMonths(query: Record<string, unknown>): number {
  const value = query.months
  if (value === undefined) return 6
  const n = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHS) {
    throw new ValidationFailed({ months: [`Un numero intero da 1 a ${MAX_MONTHS}.`] })
  }
  return n
}

interface BucketRow {
  bucket: string
  incoming: string
  outgoing: string
}

interface Amounts {
  incoming: string
  outgoing: string
  net: string
}

function amounts(incoming: bigint, outgoing: bigint): Amounts {
  return {
    incoming: centsToAmount(incoming.toString()),
    outgoing: centsToAmount(outgoing.toString()),
    net: centsToAmount((incoming - outgoing).toString()),
  }
}

/** Expected receipts and payments from the open invoices, month by month. */
export function cashFlowRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/cash-flow',
    async (request) => {
      const session = requireSession(request)
      const months = readMonths(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('invoices.view')) throw forbidden()
        // Bucket of each open invoice: 'overdue', 'undated', 'later' or the month YYYY-MM.
        const { rows } = await client.query<BucketRow>(
          `with today as (select (now() at time zone 'Europe/Rome')::date as d),
           open as (
             select i.direction, i.due_date, (${REMAINING_CENTS}) as remaining
             from public.invoices i
             where i.paid_on is null
           ), bucketed as (
             select o.direction, o.remaining, case
                 when o.due_date is null then 'undated'
                 when o.due_date < t.d then 'overdue'
                 when o.due_date >= date_trunc('month', t.d) + make_interval(months => $1)
                   then 'later'
                 else to_char(o.due_date, 'YYYY-MM')
               end as bucket
             from open o cross join today t
             where o.remaining > 0
           )
           select bucket,
             coalesce(sum(remaining) filter (where direction = 'issued'), 0)::text as incoming,
             coalesce(sum(remaining) filter (where direction = 'received'), 0)::text as outgoing
           from bucketed group by bucket
           union all
           -- The months of the forecast and today, even with nothing due.
           select 'month:' || to_char(m, 'YYYY-MM'), '0', '0'
           from today t, generate_series(date_trunc('month', t.d),
             date_trunc('month', t.d) + make_interval(months => $1 - 1), interval '1 month') m
           union all
           select 'today:' || t.d::text, '0', '0' from today t`,
          [months],
        )
        const sums = new Map<string, { incoming: bigint; outgoing: bigint }>()
        const monthKeys: string[] = []
        let today = ''
        for (const r of rows) {
          if (r.bucket.startsWith('month:')) monthKeys.push(r.bucket.slice(6))
          else if (r.bucket.startsWith('today:')) today = r.bucket.slice(6)
          else sums.set(r.bucket, { incoming: BigInt(r.incoming), outgoing: BigInt(r.outgoing) })
        }
        monthKeys.sort()
        const of = (key: string) => sums.get(key) ?? { incoming: 0n, outgoing: 0n }
        const overdue = of('overdue')
        let balance = overdue.incoming - overdue.outgoing
        let totalIn = 0n
        let totalOut = 0n
        for (const v of sums.values()) {
          totalIn += v.incoming
          totalOut += v.outgoing
        }
        const later = of('later')
        const undated = of('undated')
        return {
          today,
          overdue: amounts(overdue.incoming, overdue.outgoing),
          months: monthKeys.map((month) => {
            const v = of(month)
            balance += v.incoming - v.outgoing
            return {
              month,
              ...amounts(v.incoming, v.outgoing),
              balance: centsToAmount(balance.toString()),
            }
          }),
          later: amounts(later.incoming, later.outgoing),
          undated: amounts(undated.incoming, undated.outgoing),
          total: amounts(totalIn, totalOut),
        }
      })
    },
  )
}
