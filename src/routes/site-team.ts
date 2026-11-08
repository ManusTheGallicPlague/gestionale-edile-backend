import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { ValidationFailed, forbidden, notFound } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import type { AbsenceKind } from './employee-absences.js'
import { EMPLOYEE_DOCUMENTS_SQL } from './employees.js'

const MAX_TEAM = 200

type Params = { company: string; site: string }

interface MemberRow {
  employee_id: string
  first_name: string
  last_name: string
  job_title: string | null
  active: boolean
  absence: AbsenceKind | null
  absence_hours: string | null
  documents_expired: boolean
}

/**
 * Only names and job titles: the team is visible with sites.view, hourly costs are not. Who
 * is away today, Italian date, for everybody; why (a sick leave, say) only with employees.view.
 * Likewise who has an expired document, not which one.
 */
async function readTeam(client: PoolClient, siteId: string, seesAbsences: boolean) {
  const { rows } = await client.query<MemberRow>(
    `select e.id as employee_id, e.first_name, e.last_name, e.job_title, e.active,
       a.kind as absence, a.hours::text as absence_hours,
       ${EMPLOYEE_DOCUMENTS_SQL.expired} as documents_expired
     from public.site_team t
     join public.employees e on e.id = t.employee_id
     left join lateral (
       select x.kind, x.hours from public.employee_absences x
       where x.employee_id = e.id
         and (now() at time zone 'Europe/Rome')::date between x.starts_on and x.ends_on
       order by x.starts_on limit 1
     ) a on true
     where t.site_id = $1
     order by lower(e.last_name), lower(e.first_name), e.id`,
    [siteId],
  )
  return {
    data: rows.map((r) => ({
      employee_id: r.employee_id,
      first_name: r.first_name,
      last_name: r.last_name,
      job_title: r.job_title,
      active: r.active,
      away: r.absence !== null && r.absence_hours === null,
      absence: seesAbsences ? r.absence : null,
      absence_hours: seesAbsences ? r.absence_hours : null,
      documents_expired: r.documents_expired,
    })),
  }
}

async function siteExists(client: PoolClient, id: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from public.sites where id = $1', [id])
  return (rowCount ?? 0) > 0
}

function parseTeam(body: unknown): string[] {
  const raw =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).employee_ids
      : undefined
  if (!Array.isArray(raw)) {
    throw new ValidationFailed({ employee_ids: ['Serve un elenco di dipendenti.'] })
  }
  if (raw.length > MAX_TEAM) {
    throw new ValidationFailed({ employee_ids: [`Al massimo ${MAX_TEAM} dipendenti.`] })
  }
  if (!raw.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    throw new ValidationFailed({ employee_ids: ['Dipendente non trovato.'] })
  }
  return [...new Set(raw.map((id) => id.toLowerCase()))]
}

export function siteTeamRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const url = '/api/companies/:company/sites/:site/team'

  app.get<{ Params: Params }>(url, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      const id = request.params.site
      if (!UUID.test(id) || !(await siteExists(client, id))) throw notFound()
      return readTeam(client, id, permissions.has('employees.view'))
    })
  })

  app.put<{ Params: Params }>(url, async (request) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      if (!permissions.has('sites.update')) throw forbidden()
      const id = request.params.site
      if (!UUID.test(id) || !(await siteExists(client, id))) throw notFound()
      const employeeIds = parseTeam(request.body)
      await client.query(
        'delete from public.site_team where site_id = $1 and not (employee_id = any($2::uuid[]))',
        [id, employeeIds],
      )
      await client
        .query(
          `insert into public.site_team (company_id, site_id, employee_id)
           select app.current_company_id(), $1, unnest($2::uuid[])
           on conflict (site_id, employee_id) do nothing`,
          [id, employeeIds],
        )
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ValidationFailed({ employee_ids: ['Dipendente non trovato.'] })
          }
          throw error
        })
      return readTeam(client, id, permissions.has('employees.view'))
    })
  })
}
