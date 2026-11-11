import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { requireSession } from '../http/request-context.js'
import { addWorkingDays, easter, patronSaintDay, workingDays } from '../holidays.js'
import { readYear } from './absence-totals.js'
import { toICalendar } from '../deadlines/ical.js'
import { isIsoDate } from '../suppliers/documents.js'
import { ValidationFailed } from '../http/errors.js'

/** National holidays as MM-DD with their Italian names; Easter Monday is added per year. */
const NATIONAL: [string, string][] = [
  ['01-01', 'Capodanno'],
  ['01-06', 'Epifania'],
  ['04-25', 'Festa della Liberazione'],
  ['05-01', 'Festa del lavoro'],
  ['06-02', 'Festa della Repubblica'],
  ['08-15', 'Ferragosto'],
  ['11-01', 'Ognissanti'],
  ['12-08', 'Immacolata Concezione'],
  ['12-25', 'Natale'],
  ['12-26', 'Santo Stefano'],
]

export interface Holiday {
  date: string
  name: string
  kind: 'national' | 'patron_saint'
}

/** The holidays of a year, by date: national ones, Easter Monday and the patron saint day. */
export function holidaysOfYear(year: number, patron: string | null): Holiday[] {
  const list: Holiday[] = NATIONAL.map(([md, name]) => ({
    date: `${year}-${md}`,
    name,
    kind: 'national',
  }))
  const { month, day } = easter(year)
  list.push({
    date: new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10),
    name: "Lunedì dell'Angelo",
    kind: 'national',
  })
  if (patron && !list.some((h) => h.date === `${year}-${patron}`)) {
    list.push({ date: `${year}-${patron}`, name: 'Santo patrono', kind: 'patron_saint' })
  }
  return list.sort((a, b) => a.date.localeCompare(b.date))
}

/** The longest period countWorkingDays accepts, in calendar days. */
const MAX_PERIOD_DAYS = 731

/** Reads from and to of countWorkingDays: real dates, to not before from, at most two years. */
function readPeriod(query: Record<string, unknown>): { from: string; to: string; days: number } {
  const errors: Record<string, string[]> = {}
  const read = (name: 'from' | 'to'): string => {
    const value = query[name]
    if (value === undefined || value === '') errors[name] = ['Obbligatorio.']
    else if (typeof value !== 'string' || !isIsoDate(value)) {
      errors[name] = ['Data non valida: usa il formato AAAA-MM-GG.']
    } else return value
    return ''
  }
  const from = read('from')
  const to = read('to')
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1
  if (days < 1) throw new ValidationFailed({ to: ['Non può essere prima di from.'] })
  if (days > MAX_PERIOD_DAYS) {
    throw new ValidationFailed({ to: [`Al massimo ${MAX_PERIOD_DAYS} giorni da from.`] })
  }
  return { from, to, days }
}

/** The most working days findWorkingDaysEnd counts: about two years, like countWorkingDays. */
const MAX_WORKING_DAYS = 500

/** Reads from and working_days of findWorkingDaysEnd: a real date and 1 to 500 days. */
function readEnd(query: Record<string, unknown>): { from: string; n: number } {
  const errors: Record<string, string[]> = {}
  const from = query.from
  if (from === undefined || from === '') errors.from = ['Obbligatorio.']
  else if (typeof from !== 'string' || !isIsoDate(from)) {
    errors.from = ['Data non valida: usa il formato AAAA-MM-GG.']
  }
  const raw = query.working_days
  const n = typeof raw === 'string' && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN
  if (raw === undefined || raw === '') errors.working_days = ['Obbligatorio.']
  else if (!(n >= 1 && n <= MAX_WORKING_DAYS)) {
    errors.working_days = [`Deve essere un numero intero da 1 a ${MAX_WORKING_DAYS}.`]
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { from: from as string, n }
}

export function holidayRoutes(app: FastifyInstance, db: Db): void {
  // Any member asks, like countWorkingDays: the end of an activity from its working days.
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/working-days/end',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        await enterCompany(client, request.params.company)
        const { from, n } = readEnd(request.query)
        const to = addWorkingDays(from, n, await patronSaintDay(client))
        const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
        return { from, working_days: n, to, days: days + 1 }
      })
    },
  )

  // Any member asks: the previews of the forms need it, like the calendars need the holidays.
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/working-days',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        await enterCompany(client, request.params.company)
        const { from, to, days } = readPeriod(request.query)
        const patron = await patronSaintDay(client)
        const holidays: Holiday[] = []
        for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
          holidays.push(
            ...holidaysOfYear(year, patron).filter((h) => h.date >= from && h.date <= to),
          )
        }
        return { from, to, days, working_days: workingDays(from, to, patron), holidays }
      })
    },
  )

  // Any member sees them: every calendar of the interface needs them.
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/holidays',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        await enterCompany(client, request.params.company)
        const year = await readYear(client, request.query)
        return { year, holidays: holidaysOfYear(year, await patronSaintDay(client)) }
      })
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/holidays/calendar',
    async (request, reply) => {
      const session = requireSession(request)
      const { year, ics } = await withIdentity(
        db.app,
        { userId: session.user.id },
        async (client) => {
          await enterCompany(client, request.params.company)
          const year = await readYear(client, request.query)
          const { rows } = await client.query<{ id: string }>(
            'select app.current_company_id() as id',
          )
          const companyId = rows[0]?.id ?? ''
          // A fixed stamp: the events only change with the patron saint day of the company.
          const stamp = new Date(Date.UTC(year, 0, 1))
          const holidays = holidaysOfYear(year, await patronSaintDay(client))
          const ics = toICalendar(
            `Festività ${year}`,
            holidays.map((h) => ({
              // Company and date only: a new export updates the events instead of adding them.
              uid: `holiday-${companyId}-${h.date}`,
              date: h.date,
              summary: h.name,
              description:
                h.kind === 'national' ? 'Festività nazionale' : "Santo patrono dell'azienda",
              stamp,
              alarm: false,
            })),
            'Festività',
          )
          return { year, ics }
        },
      )
      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="festivita-${year}.ics"`)
        .send(ics)
    },
  )
}
