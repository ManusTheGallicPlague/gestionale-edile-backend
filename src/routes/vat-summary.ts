import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { toCsv, type Cell } from '../csv.js'
import { ValidationFailed, forbidden } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { SIGNED_TAXABLE, SIGNED_VAT } from './invoices.js'

type Period = 'month' | 'quarter'

interface Query {
  year: number | null
  period: Period
}

/** year: 2000 to 2100, the current Italian one if missing; period: month or quarter. */
function readQuery(query: Record<string, unknown>): Query {
  const errors: Record<string, string[]> = {}
  let year: number | null = null
  if (query.year !== undefined) {
    const n = typeof query.year === 'string' && /^\d{4}$/.test(query.year) ? Number(query.year) : 0
    if (n >= 2000 && n <= 2100) year = n
    else errors.year = ['Un anno da 2000 a 2100.']
  }
  let period: Period = 'month'
  if (query.period !== undefined) {
    if (query.period === 'month' || query.period === 'quarter') period = query.period
    else errors.period = ['Indica month o quarter.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { year, period }
}

const KEYS = [
  'sales_taxable',
  'sales_vat',
  'sales_split_payment_vat',
  'purchases_taxable',
  'purchases_vat',
  'reverse_charge_taxable',
] as const
type Key = (typeof KEYS)[number]
type Sums = Record<Key, bigint>

interface Row extends Record<Key, string> {
  period: string
  from: string
  to: string
  year: number
}

function amounts(s: Sums) {
  const out: Record<string, string> = {}
  for (const k of KEYS) out[k] = centsToAmount(s[k].toString())
  const balance = s.sales_vat - s.sales_split_payment_vat - s.purchases_vat
  return { ...(out as Record<Key, string>), balance: centsToAmount(balance.toString()) }
}

/** The summary of getVatSummary, in the shape of VatSummary. */
export async function readSummary(client: PoolClient, q: Query) {
  // One row per period of the year, even with no invoices: the series drives the join.
  const { rows } = await client.query<Row>(
    `with y as (
         select coalesce($1::int,
           extract(year from now() at time zone 'Europe/Rome')::int) as year
       ), periods as (
         select p::date as from_d,
           (p + case when $2 = 'quarter' then interval '3 month' else interval '1 month' end
             - interval '1 day')::date as to_d
         from y, generate_series(make_date(y.year, 1, 1), make_date(y.year, 12, 1),
           case when $2 = 'quarter' then interval '3 month' else interval '1 month' end) p
       )
       select y.year,
         case when $2 = 'quarter'
           then to_char(p.from_d, 'YYYY') || '-Q' || to_char(p.from_d, 'Q')
           else to_char(p.from_d, 'YYYY-MM') end as period,
         p.from_d::text as "from", p.to_d::text as "to",
         coalesce(sum(${SIGNED_TAXABLE}) filter (where i.direction = 'issued'), 0)::text
           as sales_taxable,
         coalesce(sum(${SIGNED_VAT}) filter (where i.direction = 'issued'), 0)::text as sales_vat,
         coalesce(sum(${SIGNED_VAT}) filter (where i.direction = 'issued' and i.split_payment), 0)
           ::text as sales_split_payment_vat,
         coalesce(sum(${SIGNED_TAXABLE}) filter (where i.direction = 'received'), 0)::text
           as purchases_taxable,
         coalesce(sum(${SIGNED_VAT}) filter (where i.direction = 'received'), 0)::text
           as purchases_vat,
         coalesce(sum(${SIGNED_TAXABLE}) filter (
           where i.direction = 'received' and i.vat_nature like 'N6.%'), 0)::text
           as reverse_charge_taxable
       from y cross join periods p
       left join public.invoices i on i.invoice_date between p.from_d and p.to_d
       group by y.year, p.from_d, p.to_d
       order by p.from_d`,
    [q.year, q.period],
  )
  const zero = (): Sums => ({
    sales_taxable: 0n,
    sales_vat: 0n,
    sales_split_payment_vat: 0n,
    purchases_taxable: 0n,
    purchases_vat: 0n,
    reverse_charge_taxable: 0n,
  })
  const total = zero()
  const periods = rows.map((r) => {
    const s = zero()
    for (const k of KEYS) {
      s[k] = BigInt(r[k])
      total[k] += s[k]
    }
    return { period: r.period, from: r.from, to: r.to, ...amounts(s) }
  })
  return {
    year: rows[0]?.year ?? q.year ?? new Date().getUTCFullYear(),
    period: q.period,
    periods,
    total: amounts(total),
  }
}

/** The current month and quarter in Italy, for the dashboard (DashboardVat). */
export async function currentVat(client: PoolClient, today: string) {
  const pick = async (period: Period) => {
    const s = await readSummary(client, { year: Number(today.slice(0, 4)), period })
    const found = s.periods.find((p) => p.from <= today && today <= p.to)
    if (!found) throw new Error(`no VAT period for ${today}`)
    return found
  }
  return { month: await pick('month'), quarter: await pick('quarter') }
}

/** Amount of the contract → cell of an Italian spreadsheet. */
const cellAmount = (amount: string) => amount.replace('.', ',')

/** "2026-03" → "03/2026", "2026-Q1" → "1° trimestre 2026". */
function periodLabel(period: string): string {
  const [year, part] = period.split('-')
  return part?.startsWith('Q') ? `${part.slice(1)}° trimestre ${year}` : `${part}/${year}`
}

/** VAT of the invoices register, period by period, for the VAT settlement. */
export function vatSummaryRoutes(app: FastifyInstance, db: Db): void {
  const read = (request: {
    params: { company: string }
    query: Record<string, unknown>
    session: ReturnType<typeof requireSession>
  }) => {
    const q = readQuery(request.query)
    return withIdentity(db.app, { userId: request.session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.view')) throw forbidden()
      return readSummary(client, q)
    })
  }

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/vat-summary',
    async (request) => {
      const session = requireSession(request)
      return read({ params: request.params, query: request.query, session })
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/vat-summary/export',
    async (request, reply) => {
      const session = requireSession(request)
      const s = await read({ params: request.params, query: request.query, session })
      const line = (label: string, a: ReturnType<typeof amounts>): Cell[] => [
        label,
        ...KEYS.map((k) => cellAmount(a[k])),
        cellAmount(a.balance),
      ]
      const csv = toCsv(
        [
          'Periodo',
          'Imponibile vendite',
          'IVA vendite',
          'di cui IVA in scissione',
          'Imponibile acquisti',
          'IVA acquisti',
          'Imponibile acquisti in inversione contabile',
          'Saldo IVA',
        ],
        [...s.periods.map((p) => line(periodLabel(p.period), p)), line('Totale', s.total)],
      )
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="riepilogo-iva-${s.year}.csv"`)
        .send(csv)
    },
  )
}
