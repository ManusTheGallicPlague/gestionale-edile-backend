import type { FastifyInstance, FastifyRequest } from 'fastify'
import { italianDate, toCsv } from '../csv.js'
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
import { SITES_ORDER, type SupplierSiteRow } from './site-subcontractors.js'
import { STATUS_LABELS } from './sites.js'
import {
  EMPLOYEE_DOCUMENT_KINDS,
  KIND_LABEL,
  type EmployeeDocumentKind,
} from './employee-documents.js'

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

/** True if the team of the site `site` (a parameter or a column) has an employee `e` matching. */
export const teamHas = (site: string, condition: string) =>
  `exists (select 1 from public.site_team t join public.employees e on e.id = t.employee_id
     where t.site_id = ${site} and ${condition})`

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

interface DocumentRow {
  first_name: string
  last_name: string
  job_title: string | null
  kind: EmployeeDocumentKind | null
  description: string | null
  issued_on: string | null
  expires_on: string | null
  notes: string | null
  status: string
  has_file: boolean
}

/**
 * Every document of the team, for the safety coordinator. An older document of a kind with a
 * later expiry on file is "Rinnovato": the later one is what counts, as in filter[documents].
 */
async function teamDocuments(client: PoolClient, siteId: string) {
  const { rows } = await client.query<DocumentRow>(
    `select e.first_name, e.last_name, e.job_title, d.kind, d.description,
       d.issued_on::text as issued_on, d.expires_on::text as expires_on, d.notes,
       case
         when d.id is null then 'Nessun documento'
         when d.expires_on is null then 'Senza scadenza'
         when exists (
           select 1 from public.employee_documents n
           where n.employee_id = d.employee_id and n.kind = d.kind and n.expires_on > d.expires_on
         ) then 'Rinnovato'
         when d.expires_on < (now() at time zone 'Europe/Rome')::date then 'Scaduto'
         when d.expires_on <= (now() at time zone 'Europe/Rome')::date + 30 then 'In scadenza'
         else 'Valido'
       end as status,
       exists (select 1 from public.employee_document_files f where f.document_id = d.id)
         as has_file
     from public.site_team t
     join public.employees e on e.id = t.employee_id
     left join public.employee_documents d on d.employee_id = e.id
     where t.site_id = $1
     order by lower(e.last_name), lower(e.first_name), e.id,
       array_position($2::text[], d.kind),
       d.expires_on desc nulls first, d.id`,
    [siteId, EMPLOYEE_DOCUMENT_KINDS],
  )
  return toCsv(
    [
      'Cognome',
      'Nome',
      'Mansione',
      'Documento',
      'Descrizione',
      'Rilascio',
      'Scadenza',
      'Stato',
      'Note',
      'File',
    ],
    rows.map((r) => [
      r.last_name,
      r.first_name,
      r.job_title,
      r.kind && KIND_LABEL[r.kind],
      r.description,
      r.issued_on && italianDate(r.issued_on),
      r.expires_on && italianDate(r.expires_on),
      r.status,
      r.notes,
      r.kind && (r.has_file ? 'Sì' : 'No'),
    ]),
  )
}

export async function siteExists(client: PoolClient, id: string): Promise<boolean> {
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

  app.get<{ Params: Params }>(`${url}/documents/export`, async (request, reply) => {
    const session = requireSession(request)
    const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      const id = request.params.site
      if (!UUID.test(id) || !(await siteExists(client, id))) throw notFound()
      if (!permissions.has('employees.view')) throw forbidden()
      return teamDocuments(client, id)
    })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="documenti-squadra.csv"')
      .send(csv)
  })

  // The other way round: the sites whose team has the employee, for the employee's page.
  const employeeSites = (
    request: FastifyRequest<{ Params: { company: string; employee: string } }>,
  ) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('employees.view')) throw notFound()
      const id = request.params.employee
      if (!UUID.test(id)) throw notFound()
      const found = await client.query('select 1 from public.employees where id = $1', [id])
      if (found.rowCount === 0) throw notFound()
      if (!permissions.has('sites.view')) throw forbidden()
      const { rows } = await client.query<SupplierSiteRow>(
        `select s.id, s.code, s.name, s.status
         from public.sites s
         where exists (select 1 from public.site_team t
                       where t.site_id = s.id and t.employee_id = $1)
         order by ${SITES_ORDER}`,
        [id],
      )
      return rows
    })
  }

  app.get<{ Params: { company: string; employee: string } }>(
    '/api/companies/:company/employees/:employee/sites',
    async (request) => {
      const rows = await employeeSites(request)
      return {
        data: rows.map((r) => ({ site_id: r.id, code: r.code, name: r.name, status: r.status })),
      }
    },
  )

  app.get<{ Params: { company: string; employee: string } }>(
    '/api/companies/:company/employees/:employee/sites/export',
    async (request, reply) => {
      const rows = await employeeSites(request)
      const csv = toCsv(
        ['Codice', 'Cantiere', 'Stato'],
        rows.map((r) => [r.code, r.name, STATUS_LABELS[r.status as keyof typeof STATUS_LABELS]]),
      )
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="cantieri-dipendente.csv"')
        .send(csv)
    },
  )

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
