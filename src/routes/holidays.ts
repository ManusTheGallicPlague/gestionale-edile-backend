import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { requireSession } from '../http/request-context.js'
import { easter, patronSaintDay } from '../holidays.js'
import { readYear } from './absence-totals.js'

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

export function holidayRoutes(app: FastifyInstance, db: Db): void {
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
}
