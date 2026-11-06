import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
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

interface ListRow {
  id: string
  name: string
  year: number | null
  notes: string | null
  item_count: number
  version: number
  created_at: Date
  updated_at: Date
}

interface ItemRow {
  id: string
  price_list_id: string
  code: string
  description: string
  unit: string
  unit_price_cents: string
  version: number
  created_at: Date
  updated_at: Date
}

const LIST_SELECT = `select l.id, l.name, l.year, l.notes, l.version, l.created_at, l.updated_at,
    (select count(*)::int from public.price_list_items i where i.price_list_id = l.id)
      as item_count
  from public.price_lists l`

const ITEM_SELECT = `select i.id, i.price_list_id, i.code, i.description, i.unit,
    i.unit_price_cents::text as unit_price_cents, i.version, i.created_at, i.updated_at
  from public.price_list_items i`

const listToContract = (row: ListRow) => ({
  id: row.id,
  name: row.name,
  year: row.year,
  notes: row.notes,
  item_count: row.item_count,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
})

const itemToContract = (row: ItemRow) => ({
  id: row.id,
  price_list_id: row.price_list_id,
  code: row.code,
  description: row.description,
  unit: row.unit,
  unit_price: centsToAmount(row.unit_price_cents),
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
})

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.priceListMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

/** Reads the text fields of a JSON body: all must be present, null or a string. */
function reader(body: unknown) {
  const errors: FieldErrors = {}
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number, required = false): string | null => {
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
    else if (required && trimmed === '') errors[field] = ['Campo obbligatorio.']
    return trimmed === '' ? null : trimmed
  }
  return { raw, errors, text }
}

function parseList(body: unknown) {
  const { raw, errors, text } = reader(body)
  const name = text('name', 200, true)
  let year: number | null = null
  if (!('year' in raw)) errors.year = ['Campo mancante.']
  else if (raw.year !== null) {
    if (
      typeof raw.year !== 'number' ||
      !Number.isInteger(raw.year) ||
      raw.year < 1900 ||
      raw.year > 2100
    ) {
      errors.year = ['Un anno da 1900 a 2100.']
    } else year = raw.year
  }
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !name) throw new ValidationFailed(errors)
  return { name, year, notes }
}

function parseItem(body: unknown) {
  const { errors, text } = reader(body)
  const code = text('code', 50, true)
  const description = text('description', 2000, true)
  const unit = text('unit', 20, true)
  const price = text('unit_price', 20, true)
  let unit_price_cents: string | null = null
  if (price !== null) {
    unit_price_cents = amountToCents(price)
    if (unit_price_cents === null || unit_price_cents.startsWith('-')) {
      errors.unit_price = ['Importo non valido (es. 12.50).']
    }
  }
  if (Object.keys(errors).length > 0 || !code || !description || !unit || !unit_price_cents) {
    throw new ValidationFailed(errors)
  }
  return { code, description, unit, unit_price_cents }
}

function readPage(query: Record<string, unknown>) {
  const errors: FieldErrors = {}
  const single = (name: string) => {
    const value = query[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      errors[name] = ['Indicalo una volta sola.']
      return undefined
    }
    return value
  }
  const integer = (name: string, fallback: number, max?: number) => {
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
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, search }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

async function readList(client: PoolClient, id: string | undefined) {
  if (!id || !UUID.test(id)) return undefined
  const { rows } = await client.query<ListRow>(`${LIST_SELECT} where l.id = $1`, [id])
  return rows[0]
}

async function readItem(client: PoolClient, listId: string, id: string | undefined) {
  if (!id || !UUID.test(id)) return undefined
  const { rows } = await client.query<ItemRow>(
    `${ITEM_SELECT} where i.id = $1 and i.price_list_id = $2`,
    [id, listId],
  )
  return rows[0]
}

function duplicateCode(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({ code: ['Nel prezzario c’è già una voce con questo codice.'] })
  }
  throw error
}

type Params = { company: string; list?: string; item?: string }

export function priceListRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/price-lists'

  /** Runs fn in the company with the permission; without the view permission it is 404. */
  const inCompany = <T>(
    request: { params: Params },
    userId: string,
    permission: 'view' | 'create' | 'update' | 'delete',
    fn: (client: PoolClient) => Promise<T>,
  ) =>
    withIdentity(db.app, { userId }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('price_lists.view')) {
        if (permission === 'view' || permission === 'create') throw forbidden()
        throw notFound()
      }
      if (!permissions.has(`price_lists.${permission}`)) throw forbidden()
      return fn(client)
    })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const page = readPage(request.query)
    return inCompany(request, session.user.id, 'view', async (client) => {
      const values: unknown[] = []
      let where = 'true'
      if (page.search) {
        values.push(`%${escapeLike(page.search)}%`)
        where = 'l.name ilike $1'
      }
      const n = values.length
      const { rows } = await client.query<ListRow>(
        `${LIST_SELECT} where ${where} order by l.year desc nulls last, lower(l.name), l.id
         limit $${n + 1} offset $${n + 2}`,
        [...values, page.perPage, (page.page - 1) * page.perPage],
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.price_lists l where ${where}`,
        values,
      )
      return {
        data: rows.map(listToContract),
        meta: { total: count.rows[0]?.total ?? 0, page: page.page, per_page: page.perPage },
      }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inCompany(request, session.user.id, 'create', async (client) => {
      const input = parseList(request.body)
      const { rows } = await client.query<{ id: string }>(
        `insert into public.price_lists (company_id, name, year, notes)
         values (app.current_company_id(), $1, $2, $3) returning id`,
        [input.name, input.year, input.notes],
      )
      return readList(client, rows[0]?.id)
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', `"${row.version}"`).send(listToContract(row))
  })

  app.get<{ Params: Params }>(`${base}/:list`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('price_lists.view')) throw notFound()
      return readList(client, request.params.list)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(listToContract(row))
  })

  app.put<{ Params: Params }>(`${base}/:list`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inCompany(request, session.user.id, 'update', async (client) => {
      const current = await readList(client, request.params.list)
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseList(request.body)
      const { rowCount } = await client.query(
        `update public.price_lists set name = $1, year = $2, notes = $3, version = version + 1,
           updated_at = now()
         where id = $4 and version = $5`,
        [input.name, input.year, input.notes, current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.priceListStale, 'stale_record')
      return readList(client, current.id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(listToContract(row))
  })

  app.delete<{ Params: Params }>(`${base}/:list`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await inCompany(request, session.user.id, 'delete', async (client) => {
      const current = await readList(client, request.params.list)
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.price_lists where id = $1 and version = $2',
        [current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.priceListStale, 'stale_record')
    })
    return reply.code(204).send()
  })

  const items = `${base}/:list/items`

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(items, async (request) => {
    const session = requireSession(request)
    const page = readPage(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('price_lists.view')) throw notFound()
      const list = await readList(client, request.params.list)
      if (!list) throw notFound()
      const values: unknown[] = [list.id]
      let where = 'i.price_list_id = $1'
      if (page.search) {
        values.push(`%${escapeLike(page.search)}%`)
        where += ' and (i.code ilike $2 or i.description ilike $2)'
      }
      const n = values.length
      const { rows } = await client.query<ItemRow>(
        `${ITEM_SELECT} where ${where} order by lower(i.code), i.id
         limit $${n + 1} offset $${n + 2}`,
        [...values, page.perPage, (page.page - 1) * page.perPage],
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.price_list_items i where ${where}`,
        values,
      )
      return {
        data: rows.map(itemToContract),
        meta: { total: count.rows[0]?.total ?? 0, page: page.page, per_page: page.perPage },
      }
    })
  })

  app.post<{ Params: Params }>(items, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inCompany(request, session.user.id, 'update', async (client) => {
      const list = await readList(client, request.params.list)
      if (!list) throw notFound()
      const input = parseItem(request.body)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.price_list_items (company_id, price_list_id, code, description,
             unit, unit_price_cents)
           values (app.current_company_id(), $1, $2, $3, $4, $5) returning id`,
          [list.id, input.code, input.description, input.unit, input.unit_price_cents],
        )
        .catch(duplicateCode)
      return readItem(client, list.id, rows[0]?.id)
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', `"${row.version}"`).send(itemToContract(row))
  })

  app.put<{ Params: Params }>(`${items}/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await inCompany(request, session.user.id, 'update', async (client) => {
      const list = await readList(client, request.params.list)
      const current = list && (await readItem(client, list.id, request.params.item))
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseItem(request.body)
      const { rowCount } = await client
        .query(
          `update public.price_list_items set code = $1, description = $2, unit = $3,
             unit_price_cents = $4, version = version + 1, updated_at = now()
           where id = $5 and version = $6`,
          [input.code, input.description, input.unit, input.unit_price_cents, current.id, version],
        )
        .catch(duplicateCode)
      if (!rowCount) throw new ApiError(412, messages.priceListStale, 'stale_record')
      return readItem(client, current.price_list_id, current.id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(itemToContract(row))
  })

  app.delete<{ Params: Params }>(`${items}/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await inCompany(request, session.user.id, 'update', async (client) => {
      const list = await readList(client, request.params.list)
      const current = list && (await readItem(client, list.id, request.params.item))
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.price_list_items where id = $1 and version = $2',
        [current.id, version],
      )
      if (!rowCount) throw new ApiError(412, messages.priceListStale, 'stale_record')
    })
    return reply.code(204).send()
  })
}
