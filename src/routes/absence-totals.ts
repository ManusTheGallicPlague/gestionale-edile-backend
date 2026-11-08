import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { ValidationFailed, forbidden } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { toCsv } from '../csv.js'
import { italianQuantity } from '../quotes/pdf.js'
import { workingDays } from '../holidays.js'
import { ABSENCE_KINDS, ABSENCE_NAMES, type AbsenceKind } from './employee-absences.js'

interface Row {
  id: string
  first_name: string
  last_name: string
  active: boolean
  kind: AbsenceKind | null
  /** The absence clipped to the year. */
  starts_on: string | null
  ends_on: string | null
  days: number | null
  hours: string | null
}

/** Days, working days and hours per kind; hours as hundredths, summed like cents. */
type Tally = Record<AbsenceKind, { days: number; workingDays: number; hundredths: bigint }>

const emptyTally = (): Tally =>
  Object.fromEntries(
    ABSENCE_KINDS.map((k) => [k, { days: 0, workingDays: 0, hundredths: 0n }]),
  ) as Tally

function present(tally: Tally) {
  const kinds = ABSENCE_KINDS.map((kind) => ({
    kind,
    days: tally[kind].days,
    working_days: tally[kind].workingDays,
    hours: centsToAmount(tally[kind].hundredths.toString()),
  }))
  return {
    days: ABSENCE_KINDS.reduce((sum, k) => sum + tally[k].days, 0),
    working_days: ABSENCE_KINDS.reduce((sum, k) => sum + tally[k].workingDays, 0),
    hours: centsToAmount(
      ABSENCE_KINDS.reduce((sum, k) => sum + tally[k].hundredths, 0n).toString(),
    ),
    kinds,
  }
}

async function readYear(client: PoolClient, query: Record<string, unknown>): Promise<number> {
  const value = query.year
  if (value === undefined) {
    const { rows } = await client.query<{ year: number }>(
      "select extract(year from now() at time zone 'Europe/Rome')::int as year",
    )
    return rows[0]?.year ?? new Date().getUTCFullYear()
  }
  const year = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : NaN
  if (!(year >= 2000 && year <= 2100)) {
    throw new ValidationFailed({ year: ['Un anno da 2000 a 2100.'] })
  }
  return year
}

/**
 * Absences of every active employee, and of the inactive ones with absences, in a calendar
 * year: whole-day absences as calendar days clipped to the year, leaves as hours.
 */
async function readTotals(client: PoolClient, query: Record<string, unknown>) {
  const year = await readYear(client, query)
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const { rows } = await client.query<Row>(
    `with clipped as (
       select employee_id, kind, hours,
         greatest(starts_on, $1::date) as starts_on, least(ends_on, $2::date) as ends_on
       from public.employee_absences
       where ends_on >= $1::date and starts_on <= $2::date
     )
     select e.id, e.first_name, e.last_name, e.active, a.kind,
       a.starts_on::text as starts_on, a.ends_on::text as ends_on,
       (a.ends_on - a.starts_on + 1)::int as days, a.hours::numeric(10, 2)::text as hours
     from public.employees e
     left join clipped a on a.employee_id = e.id
     where e.active or a.employee_id is not null
     order by lower(e.last_name), lower(e.first_name), e.id`,
    [from, to],
  )
  const employees: { row: Row; tally: Tally }[] = []
  const total = emptyTally()
  for (const row of rows) {
    let current = employees.at(-1)
    if (current?.row.id !== row.id) {
      current = { row, tally: emptyTally() }
      employees.push(current)
    }
    if (row.kind === null || row.starts_on === null || row.ends_on === null) continue
    for (const tally of [current.tally[row.kind], total[row.kind]]) {
      if (row.hours === null) {
        tally.days += row.days ?? 0
        tally.workingDays += workingDays(row.starts_on, row.ends_on)
      } else {
        tally.hundredths += BigInt(row.hours.replace('.', ''))
      }
    }
  }
  return {
    year,
    from,
    to,
    employees: employees.map(({ row, tally }) => ({
      employee: {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        active: row.active,
      },
      ...present(tally),
    })),
    totals: present(total),
  }
}

type Totals = Awaited<ReturnType<typeof readTotals>>

function totalsCsv(totals: Totals): string {
  const cells = (t: Totals['totals']) => [
    ...t.kinds.flatMap((k) => [k.days, k.working_days, italianQuantity(k.hours)]),
    t.days,
    t.working_days,
    italianQuantity(t.hours),
  ]
  return toCsv(
    [
      'Cognome',
      'Nome',
      ...ABSENCE_KINDS.flatMap((k) => [
        `${ABSENCE_NAMES[k]} giorni`,
        `${ABSENCE_NAMES[k]} giorni lavorativi`,
        `${ABSENCE_NAMES[k]} ore`,
      ]),
      'Totale giorni',
      'Totale giorni lavorativi',
      'Totale ore',
    ],
    [
      ...totals.employees.map((e) => [e.employee.last_name, e.employee.first_name, ...cells(e)]),
      ['Totale', null, ...cells(totals.totals)],
    ],
  )
}

export function absenceTotalsRoutes(app: FastifyInstance, db: Db): void {
  const base = '/api/companies/:company/absences/totals'
  const read = (company: string, userId: string, query: Record<string, unknown>) =>
    withIdentity(db.app, { userId }, async (client) => {
      const permissions = await enterCompany(client, company)
      if (!permissions.has('employees.view')) throw forbidden()
      return readTotals(client, query)
    })

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    base,
    async (request) => {
      const session = requireSession(request)
      return read(request.params.company, session.user.id, request.query)
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const totals = await read(request.params.company, session.user.id, request.query)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="assenze-${totals.year}.csv"`)
        .send(totalsCsv(totals))
    },
  )
}
