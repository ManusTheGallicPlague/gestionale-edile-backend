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
import { patronSaintDay, workingDays } from '../holidays.js'
import { UUID } from '../deadlines/input.js'
import { ABSENCE_KINDS, ABSENCE_NAMES, type AbsenceKind } from './employee-absences.js'

interface Row {
  id: string
  first_name: string
  last_name: string
  active: boolean
  annual_leave_days: number | null
  annual_permit_hours: number | null
  carried_over_days: number | null
  carried_over_permit_hours: string | null
  kind: AbsenceKind | null
  /** The absence clipped to the year. */
  starts_on: string | null
  ends_on: string | null
  days: number | null
  hours: string | null
}

/** Hours of a working day, for the leave hours of a whole-day leave. */
const HOURS_PER_DAY = 8n

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
function readFilters(query: Record<string, unknown>) {
  const errors: Record<string, string[]> = {}
  const single = (name: string): string | undefined => {
    const value = query[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      errors[name] = ['Un solo valore.']
      return undefined
    }
    return value
  }
  let employee: string | null = null
  const employeeValue = single('filter[employee]')
  if (employeeValue !== undefined) {
    if (UUID.test(employeeValue)) employee = employeeValue.toLowerCase()
    else errors['filter[employee]'] = ['Identificativo non valido.']
  }
  const vacationValue = single('filter[vacation]')
  if (vacationValue !== undefined && vacationValue !== 'exceeded') {
    errors['filter[vacation]'] = ['Valori ammessi: exceeded.']
  }
  const permitValue = single('filter[permit]')
  if (permitValue !== undefined && permitValue !== 'exceeded') {
    errors['filter[permit]'] = ['Valori ammessi: exceeded.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    employee,
    exceeded: vacationValue === 'exceeded',
    permitExceeded: permitValue === 'exceeded',
  }
}

export async function readTotals(client: PoolClient, query: Record<string, unknown>) {
  const filters = readFilters(query)
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
     select e.id, e.first_name, e.last_name, e.active, e.annual_leave_days, e.annual_permit_hours,
       c.days::int as carried_over_days,
       c.permit_hours::numeric(10, 2)::text as carried_over_permit_hours, a.kind,
       a.starts_on::text as starts_on, a.ends_on::text as ends_on,
       (a.ends_on - a.starts_on + 1)::int as days, a.hours::numeric(10, 2)::text as hours
     from public.employees e
     left join clipped a on a.employee_id = e.id
     left join public.employee_leave_carryovers c on c.employee_id = e.id and c.year = $3
     where ($4::uuid is null and (e.active or a.employee_id is not null)) or e.id = $4::uuid
     order by lower(e.last_name), lower(e.first_name), e.id`,
    [from, to, year, filters.employee],
  )
  const patron = await patronSaintDay(client)
  const employees: { row: Row; tally: Tally }[] = []
  for (const row of rows) {
    let current = employees.at(-1)
    if (current?.row.id !== row.id) {
      current = { row, tally: emptyTally() }
      employees.push(current)
    }
    if (row.kind === null || row.starts_on === null || row.ends_on === null) continue
    const tally = current.tally[row.kind]
    if (row.hours === null) {
      tally.days += row.days ?? 0
      tally.workingDays += workingDays(row.starts_on, row.ends_on, patron)
    } else {
      tally.hundredths += BigInt(row.hours.replace('.', ''))
    }
  }
  const remaining = ({ row, tally }: { row: Row; tally: Tally }) =>
    row.annual_leave_days === null
      ? null
      : row.annual_leave_days + (row.carried_over_days ?? 0) - tally.vacation.workingDays
  /**
   * Hours of leave left: the yearly allowance plus the hours carried over from the year
   * before, less the hours of the leaves by the hour and 8 hours for each working day of a
   * whole-day leave.
   */
  const permitRemaining = ({ row, tally }: { row: Row; tally: Tally }) =>
    row.annual_permit_hours === null
      ? null
      : centsToAmount(
          (
            BigInt(row.annual_permit_hours) * 100n +
            BigInt((row.carried_over_permit_hours ?? '0.00').replace('.', '')) -
            tally.leave.hundredths -
            BigInt(tally.leave.workingDays) * HOURS_PER_DAY * 100n
          ).toString(),
        )
  const listed = employees.filter((e) => {
    if (filters.exceeded) {
      const left = remaining(e)
      if (left === null || left >= 0) return false
    }
    return !filters.permitExceeded || (permitRemaining(e)?.startsWith('-') ?? false)
  })
  const total = emptyTally()
  for (const { tally } of listed) {
    for (const kind of ABSENCE_KINDS) {
      total[kind].days += tally[kind].days
      total[kind].workingDays += tally[kind].workingDays
      total[kind].hundredths += tally[kind].hundredths
    }
  }
  return {
    year,
    from,
    to,
    employees: listed.map((e) => ({
      employee: {
        id: e.row.id,
        first_name: e.row.first_name,
        last_name: e.row.last_name,
        active: e.row.active,
      },
      vacation_allowance: e.row.annual_leave_days,
      vacation_carried_over: e.row.carried_over_days,
      vacation_remaining: remaining(e),
      permit_allowance: e.row.annual_permit_hours,
      permit_carried_over: e.row.carried_over_permit_hours,
      permit_remaining: permitRemaining(e),
      ...present(e.tally),
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
      'Ferie anno precedente',
      'Ferie spettanti',
      'Ferie residue',
      'Permessi anno precedente (ore)',
      'Permessi spettanti (ore)',
      'Permessi residui (ore)',
    ],
    [
      ...totals.employees.map((e) => [
        e.employee.last_name,
        e.employee.first_name,
        ...cells(e),
        e.vacation_carried_over,
        e.vacation_allowance,
        e.vacation_remaining,
        e.permit_carried_over && italianQuantity(e.permit_carried_over),
        e.permit_allowance,
        e.permit_remaining && italianQuantity(e.permit_remaining),
      ]),
      ['Totale', null, ...cells(totals.totals), null, null, null, null, null, null],
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
