import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { italianAmount, italianDate, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import { UUID } from '../deadlines/input.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'

const STATUSES = ['draft', 'final'] as const
type Status = (typeof STATUSES)[number]

interface EstimateInput {
  title: string
  client_id: string | null
  site_id: string | null
  site_address: string | null
  status: Status
  notes: string | null
}
const FIELDS = ['title', 'client_id', 'site_id', 'site_address', 'status', 'notes'] as const

interface EstimateRow extends EstimateInput {
  id: string
  client_name: string | null
  site_name: string | null
  site_code: string | null
  site_cig: string | null
  site_cup: string | null
  total_cents: string
  /** Italian calendar day of the last change, for the export. */
  updated_on: string
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; estimate?: string }

const SELECT = `select e.id, e.title, e.client_id, e.site_id, s.name as site_name,
    s.code as site_code, s.cig as site_cig, s.cup as site_cup, e.site_address, e.status, e.notes, e.version,
    e.created_at, e.updated_at, c.name as client_name,
    (e.updated_at at time zone 'Europe/Rome')::date::text as updated_on,
    (select coalesce(sum(t.amount_cents), 0)::text from public.estimate_item_totals t
     where t.estimate_id = e.id) as total_cents
  from public.estimates e
  left join public.clients c on c.id = e.client_id
  left join public.sites s on s.id = e.site_id`

const SORTS = {
  title: 'lower(e.title) asc, e.id asc',
  '-title': 'lower(e.title) desc, e.id desc',
  created_at: 'e.created_at asc, e.id asc',
  '-created_at': 'e.created_at desc, e.id desc',
  updated_at: 'e.updated_at asc, e.id asc',
  '-updated_at': 'e.updated_at desc, e.id desc',
} as const

function toContract(row: EstimateRow) {
  return {
    id: row.id,
    title: row.title,
    client_id: row.client_id,
    client: row.client_id ? { id: row.client_id, name: row.client_name ?? '' } : null,
    site_id: row.site_id,
    site: row.site_id
      ? {
          id: row.site_id,
          name: row.site_name ?? '',
          code: row.site_code,
          cig: row.site_cig,
          cup: row.site_cup,
        }
      : null,
    site_address: row.site_address,
    status: row.status,
    notes: row.notes,
    total: centsToAmount(row.total_cents),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: EstimateRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.estimateMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseInput(body: unknown): { input: EstimateInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number): string | null => {
    if (!(field in raw)) {
      add(field, 'Campo mancante.')
      return null
    }
    const value = raw[field]
    if (value === null) return null
    if (typeof value !== 'string') {
      add(field, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) add(field, `Al massimo ${max} caratteri.`)
    return trimmed === '' ? null : trimmed
  }
  const title = text('title', 200)
  if (title === null && !errors.title) add('title', 'Il titolo è obbligatorio.')
  const client_id = text('client_id', 36)
  if (client_id !== null && !UUID.test(client_id) && !errors.client_id) {
    add('client_id', 'Cliente non trovato.')
  }
  const site_id = text('site_id', 36)
  if (site_id !== null && !UUID.test(site_id) && !errors.site_id) {
    add('site_id', 'Cantiere non trovato.')
  }
  const site_address = text('site_address', 300)
  const statusValue = text('status', 10)
  const status = STATUSES.find((s) => s === statusValue)
  if (!status && !errors.status) add('status', 'Stato non valido.')
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !title || !status) return { errors }
  return { input: { title, client_id, site_id, site_address, status, notes } }
}

function clientNotFound(error: unknown): never {
  if (isForeignKeyViolation(error) && error.constraint === 'estimates_site_fkey') {
    throw new ValidationFailed({ site_id: ['Cantiere non trovato.'] })
  }
  if (isForeignKeyViolation(error)) {
    throw new ValidationFailed({ client_id: ['Cliente non trovato.'] })
  }
  throw error
}

function readList(query: Record<string, unknown>) {
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
  const sortValue = single('sort') ?? '-updated_at'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const statusValue = single('filter[status]')
  const status = STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const clientId = single('filter[client]')
  if (clientId !== undefined && !UUID.test(clientId)) {
    errors['filter[client]'] = ['Identificativo non valido.']
  }
  const siteId = single('filter[site]')
  if (siteId !== undefined && !UUID.test(siteId)) {
    errors['filter[site]'] = ['Identificativo non valido.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-updated_at', search, status, clientId, siteId }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.status) add((p) => `e.status = ${p}`, list.status)
  if (list.clientId) add((p) => `e.client_id = ${p}`, list.clientId)
  if (list.siteId) add((p) => `e.site_id = ${p}`, list.siteId)
  if (list.search) {
    values.push(`%${escapeLike(list.search)}%`, list.search)
    const like = `$${values.length - 1}`
    const code = `$${values.length}`
    // CIG and CUP are stored uppercase without spaces: compare the search the same way.
    where.push(`(e.title ilike ${like} or e.site_address ilike ${like} or c.name ilike ${like}
      or exists (select 1 from public.sites cs where cs.id = e.site_id
        and strpos(coalesce(cs.cig, '') || ' ' || coalesce(cs.cup, ''),
          upper(regexp_replace(${code}, '\\s', '', 'g'))) > 0))`)
  }
  return { where, values }
}

async function readOne(client: PoolClient, id: string) {
  const { rows } = await client.query<EstimateRow>(`${SELECT} where e.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.estimateStale, 'stale_record')
}

export function estimateRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/estimates'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<EstimateRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.estimates e
         left join public.clients c on c.id = e.client_id where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(toContract),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
      }
    })
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('estimates.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<EstimateRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Titolo',
            'Cliente',
            'Indirizzo del lavoro',
            'Stato',
            'Totale',
            'Ultima modifica',
            'Note',
            'CIG',
            'CUP',
          ],
          rows.map((r) => [
            r.title,
            r.client_name,
            r.site_address,
            r.status === 'final' ? 'Definitivo' : 'Bozza',
            italianAmount(r.total_cents),
            italianDate(r.updated_on),
            r.notes,
            r.site_cig,
            r.site_cup,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="computi.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:estimate`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.view')) throw notFound()
      const id = request.params.estimate ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.create')) throw forbidden()
      const parsed = parseInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.estimates (company_id, ${FIELDS.join(', ')})
           values (app.current_company_id(), ${FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
           returning id`,
          FIELDS.map((f) => parsed.input[f]),
        )
        .catch(clientNotFound)
      return readOne(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:estimate`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.update')) throw forbidden()
      const id = request.params.estimate ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = FIELDS.map((f) => parsed.input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.estimates
           set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}`,
          values,
        )
        .catch(clientNotFound)
      if (!rowCount) return missingOrStale(client, id)
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:estimate`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.delete')) throw forbidden()
      const id = request.params.estimate ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client
        .query('delete from public.estimates where id = $1 and version = $2', [id, version])
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.estimateHasStatements, 'has_documents')
          }
          throw error
        })
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })

  app.post<{ Params: Params }>(`${base}/:estimate/duplicate`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.view')) throw notFound()
      if (!permissions.has('estimates.create')) throw forbidden()
      const id = request.params.estimate ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<{ id: string }>(
        `insert into public.estimates (company_id, title, client_id, site_id, site_address, status,
           notes)
         select company_id, left(title, 192) || ' (copia)', client_id, site_id, site_address,
           'draft', notes
         from public.estimates where id = $1
         returning id`,
        [id],
      )
      const copy = rows[0]?.id
      if (!copy) throw notFound()
      await copyTree(client, id, copy)
      return readOne(client, copy)
    })
    if (!row) throw notFound()
    return send(reply, row, 201)
  })
}

/**
 * Copies chapters, items and measurement rows of one estimate into another, with new ids.
 * One statement: the foreign keys are checked at its end, when every row is there.
 */
async function copyTree(client: PoolClient, from: string, to: string) {
  await client.query(
    `with chapter_ids as materialized (
       select id as old_id, gen_random_uuid() as new_id
       from public.estimate_chapters where estimate_id = $1
     ), item_ids as materialized (
       select id as old_id, gen_random_uuid() as new_id
       from public.estimate_items where estimate_id = $1
     ), chapters as (
       insert into public.estimate_chapters
         (id, company_id, estimate_id, parent_id, code, title, position)
       select m.new_id, c.company_id, $2, p.new_id, c.code, c.title, c.position
       from public.estimate_chapters c
       join chapter_ids m on m.old_id = c.id
       left join chapter_ids p on p.old_id = c.parent_id
     ), items as (
       insert into public.estimate_items
         (id, company_id, estimate_id, chapter_id, code, description, unit, unit_price_cents,
          position)
       select m.new_id, i.company_id, $2, c.new_id, i.code, i.description, i.unit,
         i.unit_price_cents, i.position
       from public.estimate_items i
       join item_ids m on m.old_id = i.id
       join chapter_ids c on c.old_id = i.chapter_id
     )
     insert into public.estimate_measurements
       (company_id, estimate_id, item_id, description, equal_parts, length, width, height,
        position)
     select x.company_id, $2, m.new_id, x.description, x.equal_parts, x.length, x.width,
       x.height, x.position
     from public.estimate_measurements x
     join item_ids m on m.old_id = x.item_id`,
    [from, to],
  )
}
