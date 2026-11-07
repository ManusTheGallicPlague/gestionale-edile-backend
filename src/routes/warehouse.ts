import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
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
import { MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import { csvScope } from '../http/files.js'
import { ImportFailed } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { itemRowMessages, parseWarehouseItemsCsv } from '../warehouse/import.js'

export const MOVEMENT_KINDS = ['in', 'out'] as const
type Kind = (typeof MOVEMENT_KINDS)[number]

const QUANTITY = /^\d{1,11}(?:\.\d{1,3})?$/

interface ItemInput {
  code: string | null
  name: string
  unit: string
  notes: string | null
  /** Undefined when not sent: a new item has none, an update keeps the current one. */
  min_stock?: string | null | undefined
}

interface ItemRow extends ItemInput {
  id: string
  stock: string
  min_stock: string | null
  below_min: boolean
  version: number
  created_at: Date
  updated_at: Date
}

interface MovementInput {
  item_id: string
  date: string
  kind: Kind
  quantity: string
  site_id: string | null
  notes: string | null
}

interface MovementRow {
  id: string
  item_id: string
  item_code: string | null
  item_name: string
  item_unit: string
  movement_date: string
  kind: Kind
  quantity: string
  site_id: string | null
  site_name: string | null
  site_code: string | null
  notes: string | null
  purchase_order_id: string | null
  order_year: number | null
  order_seq: number | null
  created_by: string | null
  created_by_name: string | null
  created_at: Date
}

type Params = { company: string; item?: string; movement?: string; order?: string }

const STOCK = `coalesce((select sum(case when m.kind = 'in' then m.quantity else -m.quantity end)
    from public.warehouse_movements m where m.item_id = i.id), 0)`

/** Below the minimum stock: there is a minimum and the stock is under it. */
export const BELOW_MIN = `(i.min_stock is not null and ${STOCK} < i.min_stock)`

const ITEM_SELECT = `select i.id, i.code, i.name, i.unit, i.notes,
    (${STOCK})::numeric(15, 3)::text as stock, i.min_stock::text as min_stock,
    ${BELOW_MIN} as below_min, i.version, i.created_at, i.updated_at
  from public.warehouse_items i`

const ITEM_SORTS = {
  name: 'i.name asc, i.id asc',
  '-name': 'i.name desc, i.id desc',
  code: 'i.code asc nulls last, i.id asc',
  '-code': 'i.code desc nulls last, i.id desc',
  stock: `${STOCK} asc, i.id asc`,
  '-stock': `${STOCK} desc, i.id desc`,
} as const

const MOVEMENT_SELECT = `select m.id, m.item_id, i.code as item_code, i.name as item_name,
    i.unit as item_unit, m.movement_date::text as movement_date, m.kind,
    m.quantity::text as quantity, m.site_id, s.name as site_name, s.code as site_code, m.notes,
    m.purchase_order_id, o.number_year as order_year, o.number_seq as order_seq,
    m.created_by, cu.name as created_by_name, m.created_at
  from public.warehouse_movements m
  join public.warehouse_items i on i.id = m.item_id
  left join public.sites s on s.id = m.site_id
  left join public.purchase_orders o on o.id = m.purchase_order_id
  left join lateral app.audit_users(array[m.created_by]) cu on true`

function itemToContract(row: ItemRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    notes: row.notes,
    stock: row.stock,
    min_stock: row.min_stock,
    below_min: row.below_min,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

function movementToContract(row: MovementRow) {
  return {
    id: row.id,
    item_id: row.item_id,
    item: { id: row.item_id, code: row.item_code, name: row.item_name, unit: row.item_unit },
    date: row.movement_date,
    kind: row.kind,
    quantity: row.quantity,
    site_id: row.site_id,
    site: row.site_id ? { id: row.site_id, name: row.site_name ?? '', code: row.site_code } : null,
    notes: row.notes,
    purchase_order: row.purchase_order_id
      ? {
          id: row.purchase_order_id,
          number: `${row.order_year}/${String(row.order_seq).padStart(3, '0')}`,
        }
      : null,
    created_by: row.created_by ? { id: row.created_by, name: row.created_by_name ?? '' } : null,
    created_at: row.created_at.toISOString(),
  }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.warehouseItemMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function reader(body: unknown) {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
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
  return { errors, add, text }
}

function parseItemInput(body: unknown): ItemInput {
  const { errors, add, text } = reader(body)
  const code = text('code', 50)
  const name = text('name', 200)
  if (name === null && !errors.name) add('name', 'Indica il nome dell’articolo.')
  const unit = text('unit', 20)
  if (unit === null && !errors.unit) add('unit', 'Indica l’unità di misura.')
  const notes = text('notes', 2000)
  let min_stock: string | null | undefined
  if ('min_stock' in (body as Record<string, unknown>)) {
    min_stock = text('min_stock', 20)
    if (min_stock !== null && !errors.min_stock && !QUANTITY.test(min_stock)) {
      add('min_stock', 'Una quantità da zero in su, con il punto e al massimo tre decimali.')
    }
  }
  if (Object.keys(errors).length > 0 || !name || !unit) throw new ValidationFailed(errors)
  return { code, name, unit, notes, min_stock }
}

function parseMovementInput(body: unknown): MovementInput {
  const { errors, add, text } = reader(body)
  const item_id = text('item_id', 36)
  if (item_id === null && !errors.item_id) add('item_id', 'Scegli l’articolo.')
  else if (item_id !== null && !UUID.test(item_id)) add('item_id', 'Articolo non trovato.')
  const date = text('date', 10)
  if (date === null && !errors.date) add('date', 'Indica la data.')
  else if (date !== null && !errors.date && !isIsoDate(date)) {
    add('date', 'Data non valida (AAAA-MM-GG).')
  }
  const kindValue = text('kind', 10)
  const kind = MOVEMENT_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Scegli carico o scarico.')
  const quantity = text('quantity', 20)
  if (
    !errors.quantity &&
    (quantity === null || !QUANTITY.test(quantity) || /^[0.]+$/.test(quantity))
  ) {
    add('quantity', 'Una quantità maggiore di zero, con il punto e al massimo tre decimali.')
  }
  const site_id = text('site_id', 36)
  if (site_id !== null && !errors.site_id && !UUID.test(site_id)) {
    add('site_id', 'Cantiere non trovato.')
  }
  const notes = text('notes', 2000)
  if (Object.keys(errors).length > 0 || !item_id || !date || !kind || !quantity) {
    throw new ValidationFailed(errors)
  }
  return { item_id, date, kind, quantity, site_id, notes }
}

function parseLoadInput(body: unknown): {
  date: string
  lines: { item_id: string; quantity: string }[]
} {
  const { errors, add, text } = reader(body)
  const date = text('date', 10)
  if (date === null && !errors.date) add('date', 'Indica la data del carico.')
  else if (date !== null && !errors.date && !isIsoDate(date)) {
    add('date', 'Data non valida (AAAA-MM-GG).')
  }
  const raw = (body as Record<string, unknown>).lines
  const lines: { item_id: string; quantity: string }[] = []
  if (!Array.isArray(raw) || raw.length === 0) add('lines', 'Indica almeno una riga da caricare.')
  else if (raw.length > 200) add('lines', 'Al massimo 200 righe.')
  else {
    raw.forEach((item: unknown, i) => {
      const line = (typeof item === 'object' && item !== null ? item : {}) as Record<
        string,
        unknown
      >
      const itemId = line.item_id
      const quantity = line.quantity
      if (typeof itemId !== 'string' || !UUID.test(itemId)) {
        add(`lines.${i}.item_id`, 'Scegli l’articolo.')
      }
      if (typeof quantity !== 'string' || !QUANTITY.test(quantity) || /^[0.]+$/.test(quantity)) {
        add(
          `lines.${i}.quantity`,
          'Una quantità maggiore di zero, con il punto e al massimo tre decimali.',
        )
      }
      if (typeof itemId === 'string' && typeof quantity === 'string') {
        lines.push({ item_id: itemId, quantity })
      }
    })
  }
  if (Object.keys(errors).length > 0 || !date) throw new ValidationFailed(errors)
  return { date, lines }
}

function listQuery(query: Record<string, unknown>) {
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
  const id = (name: string) => {
    const value = single(name)
    if (value !== undefined && !UUID.test(value)) errors[name] = ['Identificativo non valido.']
    return value
  }
  const date = (name: string) => {
    const value = single(name)
    if (value !== undefined && !isIsoDate(value)) {
      errors[name] = ['Data non valida (AAAA-MM-GG).']
      return undefined
    }
    return value
  }
  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const done = () => {
    if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  }
  return { errors, single, id, date, page, perPage, done }
}

async function readItem(client: PoolClient, id: string) {
  const { rows } = await client.query<ItemRow>(`${ITEM_SELECT} where i.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readItem(client, id))) throw notFound()
  throw new ApiError(412, messages.warehouseItemStale, 'stale_record')
}

function duplicateCode(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({ code: ['Esiste già un articolo con questo codice.'] })
  }
  throw error
}

/** Search and sort of the item list, shared by the list and its export. */
function itemList(query: Record<string, unknown>) {
  const q = listQuery(query)
  const search = q.single('search')
  if (search !== undefined && search.length > 100) q.errors.search = ['Al massimo 100 caratteri.']
  const sortValue = q.single('sort') ?? 'name'
  const sort = sortValue in ITEM_SORTS ? (sortValue as keyof typeof ITEM_SORTS) : 'name'
  if (!(sortValue in ITEM_SORTS)) q.errors.sort = ['Ordinamento non valido.']
  const belowMin = q.single('filter[below_min]')
  if (belowMin !== undefined && belowMin !== 'true' && belowMin !== 'false') {
    q.errors['filter[below_min]'] = ['Indica true o false.']
  }
  q.done()
  const values: unknown[] = []
  let where = 'true'
  if (search?.trim()) {
    values.push(`%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    where = `(i.name ilike $1 or i.code ilike $1)`
  }
  if (belowMin === 'true') where += ` and ${BELOW_MIN}`
  if (belowMin === 'false') where += ` and not ${BELOW_MIN}`
  return { q, sort, where, values }
}

export function warehouseRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const items = '/api/companies/:company/warehouse/items'
  const movements = '/api/companies/:company/warehouse/movements'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(items, async (request) => {
    const session = requireSession(request)
    const { q, sort, where, values } = itemList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.view')) throw forbidden()
      const filters = values.length
      values.push(q.perPage, (q.page - 1) * q.perPage)
      const { rows } = await client.query<ItemRow>(
        `${ITEM_SELECT} where ${where} order by ${ITEM_SORTS[sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.warehouse_items i where ${where}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(itemToContract),
        meta: { total: count.rows[0]?.total ?? 0, page: q.page, per_page: q.perPage },
      }
    })
  })

  csvScope(app, config, (scope) => {
    scope.post<{ Params: Params }>(`${items}/import`, async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('warehouse.create')) throw forbidden()
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(415, 'Il corpo deve essere un file CSV (text/csv).')
        }
        let imported
        try {
          imported = parseWarehouseItemsCsv(body, (row) => {
            try {
              return { input: parseItemInput(row) }
            } catch (error) {
              if (error instanceof ValidationFailed) return { errors: error.errors }
              throw error
            }
          })
        } catch (error) {
          if (error instanceof ImportFailed) throw new ValidationFailed(error.errors)
          throw error
        }
        // One savepoint per row, so a duplicate code is reported on its row.
        const errors = new RowErrors()
        let loaded = 0
        for (const { line, input, stock } of imported) {
          await client.query('savepoint import_row')
          let id: string | undefined
          try {
            const { rows } = await client.query<{ id: string }>(
              `insert into public.warehouse_items (company_id, code, name, unit, notes)
               values (app.current_company_id(), $1, $2, $3, $4) returning id`,
              [input.code, input.name, input.unit, input.notes],
            )
            id = rows[0]?.id
            await client.query('release savepoint import_row')
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            await client.query('rollback to savepoint import_row')
            errors.add(
              line,
              itemRowMessages({ code: ['Esiste già un articolo con questo codice.'] }),
            )
            continue
          }
          if (stock !== null && id) {
            await client.query(
              `insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
                 quantity, notes, created_by)
               values (app.current_company_id(), $1, (now() at time zone 'Europe/Rome')::date, 'in',
                 $2, $3, $4)`,
              [id, stock, 'Giacenza iniziale (importazione)', session.user.id],
            )
            loaded++
          }
        }
        if (!errors.empty) throw new ValidationFailed(errors.errors)
        return { created: imported.length, stock_loaded: loaded }
      })
    })
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${items}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const { sort, where, values } = itemList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('warehouse.view')) throw forbidden()
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<ItemRow>(
          `${ITEM_SELECT} where ${where} order by ${ITEM_SORTS[sort]} limit $${values.length}`,
          values,
        )
        return toCsv(
          ['Codice', 'Articolo', 'Unità', 'Giacenza', 'Note'],
          rows.map((r) => [r.code, r.name, r.unit, r.stock.replace('.', ','), r.notes]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="magazzino.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${items}/:item`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.view')) throw notFound()
      const id = request.params.item ?? ''
      if (!UUID.test(id)) throw notFound()
      return readItem(client, id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(itemToContract(row))
  })

  app.post<{ Params: Params }>(items, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.create')) throw forbidden()
      const input = parseItemInput(request.body)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.warehouse_items (company_id, code, name, unit, notes, min_stock)
           values (app.current_company_id(), $1, $2, $3, $4, $5) returning id`,
          [input.code, input.name, input.unit, input.notes, input.min_stock ?? null],
        )
        .catch(duplicateCode)
      return readItem(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', `"${row.version}"`).send(itemToContract(row))
  })

  app.put<{ Params: Params }>(`${items}/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.update')) throw forbidden()
      const id = request.params.item ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseItemInput(request.body)
      const { rowCount } = await client
        .query(
          `update public.warehouse_items
           set code = $1, name = $2, unit = $3, notes = $4,
               min_stock = case when $7 then $8::numeric else min_stock end,
               version = version + 1, updated_at = now()
           where id = $5 and version = $6`,
          [
            input.code,
            input.name,
            input.unit,
            input.notes,
            id,
            version,
            input.min_stock !== undefined,
            input.min_stock ?? null,
          ],
        )
        .catch(duplicateCode)
      if (!rowCount) return missingOrStale(client, id)
      return readItem(client, id)
    })
    if (!row) throw notFound()
    return reply.header('ETag', `"${row.version}"`).send(itemToContract(row))
  })

  app.delete<{ Params: Params }>(`${items}/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.delete')) throw forbidden()
      const id = request.params.item ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client
        .query('delete from public.warehouse_items where id = $1 and version = $2', [id, version])
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.warehouseItemHasMovements, 'has_documents')
          }
          throw error
        })
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(movements, async (request) => {
    const session = requireSession(request)
    const q = listQuery(request.query)
    const itemId = q.id('filter[item]')
    const siteId = q.id('filter[site]')
    const kindValue = q.single('filter[kind]')
    const kind = MOVEMENT_KINDS.find((k) => k === kindValue)
    if (kindValue !== undefined && !kind) q.errors['filter[kind]'] = ['Tipo non valido.']
    const from = q.date('filter[from]')
    const to = q.date('filter[to]')
    q.done()
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.view')) throw forbidden()
      const where = ['true']
      const values: unknown[] = []
      const add = (sql: (p: string) => string, value: unknown) => {
        values.push(value)
        where.push(sql(`$${values.length}`))
      }
      if (itemId) add((p) => `m.item_id = ${p}`, itemId)
      if (siteId) add((p) => `m.site_id = ${p}`, siteId)
      if (kind) add((p) => `m.kind = ${p}`, kind)
      if (from) add((p) => `m.movement_date >= ${p}`, from)
      if (to) add((p) => `m.movement_date <= ${p}`, to)
      const filters = values.length
      values.push(q.perPage, (q.page - 1) * q.perPage)
      const { rows } = await client.query<MovementRow>(
        `${MOVEMENT_SELECT} where ${where.join(' and ')}
         order by m.movement_date desc, m.created_at desc, m.id desc
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.warehouse_movements m
         where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(movementToContract),
        meta: { total: count.rows[0]?.total ?? 0, page: q.page, per_page: q.perPage },
      }
    })
  })

  app.post<{ Params: Params }>(movements, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.create')) throw forbidden()
      const input = parseMovementInput(request.body)
      const errors: FieldErrors = {}
      const item = await client.query('select 1 from public.warehouse_items where id = $1', [
        input.item_id,
      ])
      if (!item.rowCount) errors.item_id = ['Articolo non trovato.']
      if (input.site_id) {
        const site = await client.query('select 1 from public.sites where id = $1', [input.site_id])
        if (!site.rowCount) errors.site_id = ['Cantiere non trovato.']
      }
      if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
             quantity, site_id, notes, created_by)
           values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            input.item_id,
            input.date,
            input.kind,
            input.quantity,
            input.site_id,
            input.notes,
            session.user.id,
          ],
        )
        .catch((error: unknown) => {
          // An item or site deleted between the check and the write.
          if (isForeignKeyViolation(error)) {
            throw new ValidationFailed({ item_id: ['Articolo o cantiere non trovato.'] })
          }
          throw error
        })
      const { rows: found } = await client.query<MovementRow>(
        `${MOVEMENT_SELECT} where m.id = $1`,
        [rows[0]?.id ?? ''],
      )
      return found[0]
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).send(movementToContract(row))
  })

  app.post<{ Params: Params }>(
    '/api/companies/:company/purchase-orders/:order/warehouse-loads',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const rows = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('purchases.view')) throw notFound()
        if (!permissions.has('warehouse.create')) throw forbidden()
        const orderId = request.params.order ?? ''
        if (!UUID.test(orderId)) throw notFound()
        const input = parseLoadInput(request.body)
        // Locked, so it cannot go back from received while the load is written.
        const order = await client.query<{ status: string }>(
          'select status from public.purchase_orders where id = $1 for update',
          [orderId],
        )
        if (!order.rows[0]) throw notFound()
        if (order.rows[0].status !== 'received') {
          throw new ApiError(409, messages.orderNotReceived, 'invalid_transition')
        }
        const { rows: found } = await client.query<{ id: string }>(
          'select id::text as id from public.warehouse_items where id = any($1::uuid[])',
          [input.lines.map((l) => l.item_id)],
        )
        const known = new Set(found.map((r) => r.id))
        const errors: FieldErrors = {}
        input.lines.forEach((l, i) => {
          if (!known.has(l.item_id)) errors[`lines.${i}.item_id`] = ['Articolo non trovato.']
        })
        if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
        const { rows: created } = await client.query<{ id: string }>(
          `insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
             quantity, purchase_order_id, created_by)
           select app.current_company_id(), x.item_id, $1, 'in', x.quantity, $2, $3
           from unnest($4::uuid[], $5::numeric[]) with ordinality as x (item_id, quantity, n)
           order by x.n
           returning id`,
          [
            input.date,
            orderId,
            session.user.id,
            input.lines.map((l) => l.item_id),
            input.lines.map((l) => l.quantity),
          ],
        )
        const { rows: movementRows } = await client.query<MovementRow>(
          `${MOVEMENT_SELECT} where m.id = any($1::uuid[]) order by m.item_id`,
          [created.map((r) => r.id)],
        )
        const order_ = new Map(created.map((r, i) => [r.id, i]))
        return movementRows.sort((a, b) => (order_.get(a.id) ?? 0) - (order_.get(b.id) ?? 0))
      })
      return reply.code(201).send({ data: rows.map(movementToContract) })
    },
  )

  app.delete<{ Params: Params }>(`${movements}/:movement`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('warehouse.delete')) throw forbidden()
      const id = request.params.movement ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rowCount } = await client.query(
        'delete from public.warehouse_movements where id = $1',
        [id],
      )
      if (!rowCount) throw notFound()
    })
    return reply.code(204).send()
  })
}
