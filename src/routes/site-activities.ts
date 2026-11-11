import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { isIsoDate } from '../suppliers/documents.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MAX_EXPORT_ROWS, italianDate, toCsv } from '../csv.js'
import { workingDays } from '../holidays.js'

const MAX_ACTIVITIES = 500
const MAX_DEPENDENCIES = 50

type Params = { company: string; site: string; activity?: string }

interface ActivityRow {
  id: string
  site_id: string
  name: string
  start_on: string
  end_on: string
  progress: number
  depends_on: string[]
  notes: string | null
  patron: string | null
  version: number
  created_at: Date
  updated_at: Date
}

interface ActivityInput {
  name: string
  start_on: string
  end_on: string
  progress: number
  depends_on: string[]
  notes: string | null
}

const SELECT = `select a.id, a.site_id, a.name, a.start_on::text as start_on,
    a.end_on::text as end_on, a.progress, a.notes, a.version, a.created_at, a.updated_at,
    array(select d.depends_on_id::text from public.site_activity_dependencies d
          where d.activity_id = a.id order by d.depends_on_id) as depends_on,
    (select p.patron_saint_day from public.company_profiles p
     where p.company_id = app.current_company_id()) as patron
  from public.site_activities a`

const toContract = (row: ActivityRow) => ({
  id: row.id,
  site_id: row.site_id,
  name: row.name,
  start_on: row.start_on,
  end_on: row.end_on,
  progress: row.progress,
  depends_on: row.depends_on,
  notes: row.notes,
  working_days: workingDays(row.start_on, row.end_on, row.patron),
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
})

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.activityMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseActivity(body: unknown): ActivityInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const errors: FieldErrors = {}
  const text = (field: string, max: number): string | null => {
    if (!(field in raw)) {
      errors[field] = ['Campo mancante.']
      return null
    }
    const value = raw[field]
    if (value !== null && typeof value !== 'string') {
      errors[field] = ['Deve essere un testo.']
      return null
    }
    const trimmed = (value ?? '').trim()
    if (trimmed.length > max) errors[field] = [`Al massimo ${max} caratteri.`]
    return trimmed === '' ? null : trimmed
  }
  const date = (field: string): string | null => {
    const value = text(field, 10)
    if (errors[field]) return null
    if (value === null) errors[field] = ['Campo obbligatorio.']
    else if (!isIsoDate(value)) errors[field] = ['Data non valida (AAAA-MM-GG).']
    else return value
    return null
  }
  const name = text('name', 200)
  if (name === null && !errors.name) errors.name = ['Campo obbligatorio.']
  const start_on = date('start_on')
  const end_on = date('end_on')
  if (start_on && end_on && end_on < start_on) {
    errors.end_on = ['La fine non può essere prima dell’inizio.']
  }
  const progress = raw.progress
  if (!('progress' in raw)) errors.progress = ['Campo mancante.']
  else if (
    typeof progress !== 'number' ||
    !Number.isInteger(progress) ||
    progress < 0 ||
    progress > 100
  ) {
    errors.progress = ['Un numero intero da 0 a 100.']
  }
  const deps = raw.depends_on
  let depends_on: string[] = []
  if (!Array.isArray(deps)) errors.depends_on = ['Serve un elenco di attività.']
  else if (deps.length > MAX_DEPENDENCIES) {
    errors.depends_on = [`Al massimo ${MAX_DEPENDENCIES} dipendenze.`]
  } else if (!deps.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    errors.depends_on = ['Attività non trovata.']
  } else depends_on = [...new Set(deps.map((id) => id.toLowerCase()))]
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !name || !start_on || !end_on) {
    throw new ValidationFailed(errors)
  }
  return { name, start_on, end_on, progress: progress as number, depends_on, notes }
}

/**
 * Writers lock the site row: changes to the schedule of a site run one at a time, so two
 * concurrent edits cannot close a cycle of dependencies or pass the activity limit.
 */
async function siteExists(client: PoolClient, id: string, lock: boolean): Promise<boolean> {
  if (!UUID.test(id)) return false
  const { rowCount } = await client.query(
    `select 1 from public.sites where id = $1${lock ? ' for update' : ''}`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

async function readActivity(client: PoolClient, siteId: string, id: string | undefined) {
  if (!id || !UUID.test(id)) return undefined
  const { rows } = await client.query<ActivityRow>(`${SELECT} where a.id = $1 and a.site_id = $2`, [
    id,
    siteId,
  ])
  return rows[0]
}

/** Replaces the dependencies of an activity, refusing unknown activities and cycles. */
async function writeDependencies(
  client: PoolClient,
  siteId: string,
  activityId: string,
  dependsOn: string[],
) {
  if (dependsOn.includes(activityId)) {
    throw new ValidationFailed({ depends_on: ['Un’attività non può dipendere da se stessa.'] })
  }
  const { rows } = await client.query<{ n: number }>(
    'select count(*)::int as n from public.site_activities where site_id = $1 and id = any($2::uuid[])',
    [siteId, dependsOn],
  )
  if ((rows[0]?.n ?? 0) !== dependsOn.length) {
    throw new ValidationFailed({ depends_on: ['Attività non trovata.'] })
  }
  await client.query(
    `delete from public.site_activity_dependencies
     where activity_id = $1 and not (depends_on_id = any($2::uuid[]))`,
    [activityId, dependsOn],
  )
  await client.query(
    `insert into public.site_activity_dependencies (company_id, site_id, activity_id, depends_on_id)
     select app.current_company_id(), $1, $2, unnest($3::uuid[])
     on conflict (activity_id, depends_on_id) do nothing`,
    [siteId, activityId, dependsOn],
  )
  const cycle = await client.query(
    `with recursive up(id) as (
       select depends_on_id from public.site_activity_dependencies where activity_id = $1
       union
       select d.depends_on_id from public.site_activity_dependencies d join up on d.activity_id = up.id
     )
     select 1 from up where id = $1 limit 1`,
    [activityId],
  )
  if (cycle.rowCount) {
    throw new ValidationFailed({ depends_on: ['Le dipendenze formano un ciclo.'] })
  }
}

const TODAY = "(now() at time zone 'Europe/Rome')::date"
const FOLLOWED_SITE =
  "(select s.status from public.sites s where s.id = a.site_id) in ('planned', 'active')"

/**
 * Schedule activities to follow, only on planned or active sites: the same conditions for
 * filter[follow_up] in the company list and for the dashboard (alias `a`).
 */
export const ACTIVITY_FOLLOW_UPS = {
  late: `(${FOLLOWED_SITE} and a.progress < 100 and a.end_on < ${TODAY})`,
  starting_soon: `(${FOLLOWED_SITE} and a.progress = 0 and a.start_on between ${TODAY} and ${TODAY} + 7)`,
  in_progress: `(${FOLLOWED_SITE} and a.progress < 100 and ${TODAY} between a.start_on and a.end_on)`,
} as const

type FollowUp = keyof typeof ACTIVITY_FOLLOW_UPS
const isFollowUp = (value: string): value is FollowUp => Object.hasOwn(ACTIVITY_FOLLOW_UPS, value)

function readCompanyList(query: Record<string, unknown>) {
  const errors: FieldErrors = {}
  const single = (name: string): string | undefined => {
    const value = query[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      errors[name] = ['Indicalo una volta sola.']
      return undefined
    }
    return value
  }
  const integer = (name: string, fallback: number, max?: number): number => {
    const value = single(name)
    if (value === undefined) return fallback
    const n = /^\d{1,6}$/.test(value) ? Number(value) : NaN
    if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
      errors[name] = [max ? `Un numero intero da 1 a ${max}.` : 'Un numero intero da 1 in su.']
      return fallback
    }
    return n
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const where = ['true']
  const values: unknown[] = []
  const site = single('filter[site]')
  if (site !== undefined) {
    if (!UUID.test(site)) errors['filter[site]'] = ['Identificativo non valido.']
    else {
      values.push(site.toLowerCase())
      where.push(`a.site_id = $${values.length}`)
    }
  }
  const followUp = single('filter[follow_up]')
  if (followUp !== undefined) {
    if (isFollowUp(followUp)) where.push(ACTIVITY_FOLLOW_UPS[followUp])
    else errors['filter[follow_up]'] = ['Valori ammessi: late, starting_soon, in_progress.']
  }
  // The activities that overlap the period: they end on or after `from`, start on or before `to`.
  const period: Partial<Record<'from' | 'to', string>> = {}
  for (const [key, sql] of [
    ['from', 'a.end_on >='],
    ['to', 'a.start_on <='],
  ] as const) {
    const name = `filter[${key}]`
    const value = single(name)
    if (value === undefined) continue
    if (!isIsoDate(value)) {
      errors[name] = ['Data non valida (AAAA-MM-GG).']
      continue
    }
    period[key] = value
    values.push(value)
    where.push(`${sql} $${values.length}::date`)
  }
  if (period.from && period.to && period.to < period.from) {
    errors['filter[to]'] = ['La fine non può essere prima dell’inizio.']
  }
  const text = single('filter[q]')?.trim()
  if (text !== undefined && text.length > 100) errors['filter[q]'] = ['Al massimo 100 caratteri.']
  else if (text) {
    values.push(text)
    // strpos, not like: the text has no wildcards.
    where.push(`strpos(lower(a.name || ' ' || coalesce(a.notes, '') || ' ' ||
      (select s.name || ' ' || coalesce(s.code, '') from public.sites s where s.id = a.site_id)),
      lower($${values.length})) > 0`)
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, where: where.join(' and '), values }
}

interface CompanyActivityRow extends ActivityRow {
  site_name: string
  site_code: string | null
  site_status: string
  days_late: number
  today: string
}

/**
 * Working days left to an unfinished activity: from today, or from its start if later, to its
 * end. Zero when it is finished or its end has passed.
 */
const remainingWorkingDays = (r: CompanyActivityRow) =>
  r.progress >= 100
    ? 0
    : workingDays(r.today > r.start_on ? r.today : r.start_on, r.end_on, r.patron)

/** The company activities matching the list filters, in the list order. */
async function readCompanyActivities(
  client: PoolClient,
  list: ReturnType<typeof readCompanyList>,
  limit: number,
  offset: number,
) {
  const { rows } = await client.query<CompanyActivityRow>(
    `select x.*, s.name as site_name, s.code as site_code, s.status as site_status
     from (${SELECT.replace(
       'a.created_at, a.updated_at,',
       `a.created_at, a.updated_at,
         case when a.progress < 100 and a.end_on < ${TODAY}
           then ${TODAY} - a.end_on else 0 end as days_late, ${TODAY}::text as today,`,
     )} where ${list.where}) x
     join public.sites s on s.id = x.site_id
     order by x.end_on, x.start_on, lower(x.name), x.id
     limit ${limit} offset ${offset}`,
    list.values,
  )
  return rows
}

export function siteActivityRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/sites/:site/activities'

  /** sites.view to see the site (404 otherwise), sites.update to change the schedule. */
  const inSite = <T>(
    request: { params: Params },
    userId: string,
    write: boolean,
    fn: (client: PoolClient, siteId: string) => Promise<T>,
  ) =>
    withIdentity(db.app, { userId }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      if (write && !permissions.has('sites.update')) throw forbidden()
      const siteId = request.params.site
      if (!(await siteExists(client, siteId, write))) throw notFound()
      return fn(client, siteId)
    })

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/activities/export',
    async (request, reply) => {
      const session = requireSession(request)
      const list = readCompanyList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('sites.view')) throw forbidden()
        const rows = await readCompanyActivities(client, list, MAX_EXPORT_ROWS, 0)
        return toCsv(
          [
            'Cantiere',
            'Codice cantiere',
            'Attività',
            'Inizio',
            'Fine',
            'Avanzamento %',
            'Giorni di ritardo',
            'Note',
            'Giorni lavorativi',
            'Giorni lavorativi rimanenti',
          ],
          rows.map((r) => [
            r.site_name,
            r.site_code,
            r.name,
            italianDate(r.start_on),
            italianDate(r.end_on),
            r.progress,
            r.days_late,
            r.notes,
            workingDays(r.start_on, r.end_on, r.patron),
            remainingWorkingDays(r),
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="cronoprogramma.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/activities',
    async (request) => {
      const session = requireSession(request)
      const list = readCompanyList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('sites.view')) throw forbidden()
        const rows = await readCompanyActivities(
          client,
          list,
          list.perPage,
          (list.page - 1) * list.perPage,
        )
        const count = await client.query<{ total: number }>(
          `select count(*)::int as total from public.site_activities a where ${list.where}`,
          list.values,
        )
        return {
          data: rows.map((r) => ({
            ...toContract(r),
            site: { id: r.site_id, name: r.site_name, code: r.site_code, status: r.site_status },
            days_late: r.days_late,
            remaining_working_days: remainingWorkingDays(r),
          })),
          meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
        }
      })
    },
  )

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return inSite(request, session.user.id, false, async (client, siteId) => {
      const { rows } = await client.query<ActivityRow>(
        `${SELECT} where a.site_id = $1 order by a.start_on, a.end_on, lower(a.name), a.id
         limit ${MAX_ACTIVITIES}`,
        [siteId],
      )
      return { data: rows.map(toContract) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inSite(request, session.user.id, true, async (client, siteId) => {
      const input = parseActivity(request.body)
      const count = await client.query<{ n: number }>(
        'select count(*)::int as n from public.site_activities where site_id = $1',
        [siteId],
      )
      if ((count.rows[0]?.n ?? 0) >= MAX_ACTIVITIES) {
        throw new ValidationFailed({ _: [`Al massimo ${MAX_ACTIVITIES} attività per cantiere.`] })
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into public.site_activities (company_id, site_id, name, start_on, end_on,
           progress, notes)
         values (app.current_company_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [siteId, input.name, input.start_on, input.end_on, input.progress, input.notes],
      )
      const id = rows[0]?.id
      if (!id) throw new Error('insert returned no row')
      await writeDependencies(client, siteId, id, input.depends_on)
      return readActivity(client, siteId, id)
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.put<{ Params: Params }>(`${base}/:activity`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inSite(request, session.user.id, true, async (client, siteId) => {
      const current = await readActivity(client, siteId, request.params.activity)
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseActivity(request.body)
      const { rowCount } = await client.query(
        `update public.site_activities set name = $1, start_on = $2, end_on = $3, progress = $4,
           notes = $5, version = version + 1, updated_at = now()
         where id = $6 and version = $7`,
        [
          input.name,
          input.start_on,
          input.end_on,
          input.progress,
          input.notes,
          current.id,
          version,
        ],
      )
      if (!rowCount) throw new ApiError(412, messages.activityStale, 'stale_record')
      await writeDependencies(client, siteId, current.id, input.depends_on)
      return readActivity(client, siteId, current.id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(toContract(row))
  })

  app.delete<{ Params: Params }>(`${base}/:activity`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await inSite(request, session.user.id, true, async (client, siteId) => {
      const current = await readActivity(client, siteId, request.params.activity)
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.site_activities where id = $1 and version = $2',
        [current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.activityStale, 'stale_record')
    })
    return reply.code(204).send()
  })
}
