import { italianAmount, italianDate, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import {
  DEADLINE_COLUMNS,
  DEADLINE_KINDS,
  UUID,
  parseDeadlineInput,
  type DeadlineInput,
} from '../deadlines/input.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { centsToAmount } from '../money.js'
import { isIsoDate } from '../suppliers/documents.js'

interface DeadlineRow extends Omit<DeadlineInput, 'amount_cents'> {
  id: string
  amount_cents: string | null
  status: 'open' | 'done'
  next_deadline_id: string | null
  supplier_document_id: string | null
  done_at: Date | null
  client_name: string | null
  supplier_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; deadline?: string }

// Dates leave the database as text, never as a JavaScript Date shifted by the time zone.
const SELECT = `select d.id, d.title, d.due_on::text as due_on, d.kind, d.amount_cents::text as amount_cents,
    d.client_id, d.supplier_id, d.notes, d.recurrence, d.next_deadline_id,
    d.supplier_document_id, d.status, d.done_at, d.version, d.created_at, d.updated_at,
    c.name as client_name, s.name as supplier_name
  from public.deadlines d
  left join public.clients c on c.id = d.client_id
  left join public.suppliers s on s.id = d.supplier_id`

const SORTS = { due_on: 'd.due_on asc, d.id asc', '-due_on': 'd.due_on desc, d.id desc' } as const

function toContract(row: DeadlineRow) {
  return {
    id: row.id,
    title: row.title,
    due_on: row.due_on,
    kind: row.kind,
    amount: row.amount_cents === null ? null : centsToAmount(row.amount_cents),
    client_id: row.client_id,
    supplier_id: row.supplier_id,
    client: row.client_id ? { id: row.client_id, name: row.client_name ?? '' } : null,
    supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? '' } : null,
    notes: row.notes,
    recurrence: row.recurrence,
    next_deadline_id: row.next_deadline_id,
    supplier_document_id: row.supplier_document_id,
    status: row.status,
    done_at: row.done_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.from) add((p) => `d.due_on >= ${p}::date`, list.from)
  if (list.to) add((p) => `d.due_on <= ${p}::date`, list.to)
  if (list.kind) add((p) => `d.kind = ${p}`, list.kind)
  if (list.status) add((p) => `d.status = ${p}`, list.status)
  if (list.clientId) add((p) => `d.client_id = ${p}`, list.clientId)
  if (list.supplierId) add((p) => `d.supplier_id = ${p}`, list.supplierId)
  if (list.search) {
    add((p) => `(d.title ilike ${p} or d.notes ilike ${p})`, `%${escapeLike(list.search)}%`)
  }
  return { where, values }
}

const KIND_LABELS: Record<string, string> = {
  durc: 'DURC',
  insurance: 'Assicurazione',
  tax: 'Imposte',
  invoice_in: 'Fattura da pagare',
  invoice_out: 'Fattura da incassare',
  contract: 'Contratto',
  vehicle: 'Mezzo',
  other: 'Altro',
}
const RECURRENCE_LABELS: Record<string, string> = {
  monthly: 'Mensile',
  quarterly: 'Trimestrale',
  yearly: 'Annuale',
}

const send = (reply: FastifyReply, row: DeadlineRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.deadlineMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

async function readOne(client: PoolClient, id: string): Promise<DeadlineRow | undefined> {
  const { rows } = await client.query<DeadlineRow>(`${SELECT} where d.id = $1`, [id])
  return rows[0]
}

const STEP = { monthly: '1 month', quarterly: '3 months', yearly: '1 year' } as const

/**
 * A completed recurring deadline gets its next one, once: next_deadline_id remembers it, so
 * reopening and completing again creates no duplicate. The next one copies everything but
 * the date, which moves by the recurrence (31 January + 1 month = 28 February).
 */
async function createNext(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `with source as (
       select * from public.deadlines
       where id = $1 and recurrence is not null and next_deadline_id is null
     ), next as (
       insert into public.deadlines (company_id, title, due_on, kind, amount_cents, client_id,
         supplier_id, notes, recurrence)
       select company_id, title,
         (due_on + case recurrence
           when 'monthly' then interval '${STEP.monthly}'
           when 'quarterly' then interval '${STEP.quarterly}'
           else interval '${STEP.yearly}' end)::date,
         kind, amount_cents, client_id, supplier_id, notes, recurrence
       from source
       returning id
     )
     update public.deadlines set next_deadline_id = (select id from next)
     where id = $1 and exists (select 1 from next)`,
    [id],
  )
}

/** The composite foreign keys refuse a client or supplier of another company, or a missing one. */
function subjectNotFound(error: unknown): never {
  if (isForeignKeyViolation(error)) {
    const field = error.constraint?.includes('supplier') ? 'supplier_id' : 'client_id'
    throw new ValidationFailed({ [field]: ['Soggetto non trovato.'] })
  }
  throw error
}

/** Writes, then reads back with the names; nothing changed means 404 or 412. */
async function writeThenRead(
  client: PoolClient,
  id: string,
  write: () => Promise<number | null>,
): Promise<DeadlineRow> {
  const changed = await write().catch(subjectNotFound)
  const row = await readOne(client, id)
  if (!row) throw notFound()
  if (!changed) throw new ApiError(412, messages.deadlineStale, 'stale_record')
  return row
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
  const date = (name: string) => {
    const value = single(name)
    if (value !== undefined && !isIsoDate(value)) {
      errors[name] = ['Data non valida: usa il formato AAAA-MM-GG.']
      return undefined
    }
    return value
  }
  const oneOf = <T extends string>(name: string, allowed: readonly T[]) => {
    const value = single(name)
    const found = allowed.find((a) => a === value)
    if (value !== undefined && !found) errors[name] = ['Valore non valido.']
    return found
  }
  const id = (name: string) => {
    const value = single(name)
    if (value !== undefined && !UUID.test(value)) errors[name] = ['Identificativo non valido.']
    return value
  }

  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const sort = oneOf('sort', ['due_on', '-due_on'] as const) ?? 'due_on'
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (from && to && to < from) errors['filter[to]'] = ['La fine viene prima dell’inizio.']
  const kind = oneOf('filter[kind]', DEADLINE_KINDS)
  const status = oneOf('filter[status]', ['open', 'done'] as const)
  const clientId = id('filter[client]')
  const supplierId = id('filter[supplier]')

  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort, search, from, to, kind, status, clientId, supplierId }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

export function deadlineRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/deadlines'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('deadlines.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<DeadlineRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.deadlines d where ${where.join(' and ')}`,
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
        if (!permissions.has('deadlines.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<DeadlineRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Scadenza',
            'Titolo',
            'Tipo',
            'Importo',
            'Cliente',
            'Fornitore',
            'Stato',
            'Ricorrenza',
            'Note',
          ],
          rows.map((r) => [
            italianDate(r.due_on),
            r.title,
            KIND_LABELS[r.kind] ?? r.kind,
            r.amount_cents === null ? null : italianAmount(r.amount_cents),
            r.client_name,
            r.supplier_name,
            r.status === 'done' ? 'Fatta' : 'Aperta',
            r.recurrence ? (RECURRENCE_LABELS[r.recurrence] ?? r.recurrence) : null,
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="scadenze.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/summary`, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('deadlines.view')) throw forbidden()
      const { rows } = await client.query<Record<string, string>>(
        `with today as (select (now() at time zone 'Europe/Rome')::date as d)
         select today.d::text as today,
           count(*) filter (where due_on < today.d)::text as overdue_count,
           coalesce(sum(amount_cents) filter (where due_on < today.d), 0)::text as overdue_cents,
           count(*) filter (where due_on between today.d and today.d + 7)::text as next7_count,
           coalesce(sum(amount_cents) filter (where due_on between today.d and today.d + 7), 0)::text
             as next7_cents,
           count(*) filter (where due_on between today.d and today.d + 30)::text as next30_count,
           coalesce(sum(amount_cents) filter (where due_on between today.d and today.d + 30), 0)::text
             as next30_cents
         from today left join public.deadlines on status = 'open'
         group by today.d`,
      )
      const r = rows[0] ?? {}
      const bucket = (name: string) => ({
        count: Number(r[`${name}_count`] ?? 0),
        amount: centsToAmount(r[`${name}_cents`] ?? '0'),
      })
      return {
        today: r.today,
        overdue: bucket('overdue'),
        next_7_days: bucket('next7'),
        next_30_days: bucket('next30'),
      }
    })
  })

  app.get<{ Params: Params }>(`${base}/:deadline`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('deadlines.view')) throw notFound()
      const id = request.params.deadline ?? ''
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
      if (!permissions.has('deadlines.create')) throw forbidden()
      const parsed = parseDeadlineInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.deadlines (company_id, ${DEADLINE_COLUMNS.join(', ')})
           values (app.current_company_id(), ${DEADLINE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           returning id`,
          DEADLINE_COLUMNS.map((c) => parsed.input[c]),
        )
        .catch(subjectNotFound)
      return readOne(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:deadline`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('deadlines.update')) throw forbidden()
      const id = request.params.deadline ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const parsed = parseDeadlineInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = DEADLINE_COLUMNS.map((c) => parsed.input[c])
      values.push(id, version)
      return writeThenRead(client, id, async () => {
        const { rowCount } = await client.query(
          `update public.deadlines
           set ${DEADLINE_COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}`,
          values,
        )
        return rowCount
      })
    })
    return send(reply, row)
  })

  for (const action of ['complete', 'reopen'] as const) {
    app.post<{ Params: Params }>(`${base}/:deadline/${action}`, async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('deadlines.update')) throw forbidden()
        const id = request.params.deadline ?? ''
        if (!UUID.test(id)) throw notFound()
        const version = expectedVersion(request.headers['if-match'])
        const set =
          action === 'complete'
            ? "status = 'done', done_at = coalesce(done_at, now())"
            : "status = 'open', done_at = null"
        return writeThenRead(client, id, async () => {
          const { rowCount } = await client.query(
            `update public.deadlines set ${set}, version = version + 1, updated_at = now()
             where id = $1 and version = $2`,
            [id, version],
          )
          if (rowCount && action === 'complete') await createNext(client, id)
          return rowCount
        })
      })
      return send(reply, row)
    })
  }

  app.delete<{ Params: Params }>(`${base}/:deadline`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('deadlines.delete')) throw forbidden()
      const id = request.params.deadline ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.deadlines where id = $1 and version = $2',
        [id, version],
      )
      if (rowCount) return
      if (!(await readOne(client, id))) throw notFound()
      throw new ApiError(412, messages.deadlineStale, 'stale_record')
    })
    return reply.code(204).send()
  })
}
