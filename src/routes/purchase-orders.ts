import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { amountToCents, centsToAmount } from '../money.js'
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

export const ORDER_STATUSES = ['draft', 'sent', 'received'] as const
type Status = (typeof ORDER_STATUSES)[number]

const QUANTITY = /^\d{1,11}(?:\.\d{1,3})?$/
const MAX_LINES = 200
/** At most 100 000 000 000.00 per line, so 200 lines stay within an Amount and a bigint. */
const MAX_LINE_CENTS = 10n ** 13n

/** Quantity × price in cents, rounded half up like the database does. */
function lineCents(quantity: string, cents: string): bigint {
  const [whole = '0', fraction = ''] = quantity.split('.')
  const thousandths = BigInt(whole + fraction.padEnd(3, '0'))
  return (thousandths * BigInt(cents) + 500n) / 1000n
}

interface LineInput {
  description: string
  unit: string | null
  quantity: string
  unit_price_cents: string
}

interface OrderInput {
  supplier_id: string
  site_id: string | null
  date: string
  delivery_date: string | null
  notes: string | null
  lines: LineInput[]
}

interface OrderRow {
  id: string
  number_year: number
  number_seq: number
  status: Status
  supplier_id: string
  supplier_name: string
  site_id: string | null
  site_name: string | null
  site_code: string | null
  order_date: string
  delivery_date: string | null
  notes: string | null
  line_count: number
  total_cents: string
  sent_at: Date | null
  received_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

interface LineRow {
  description: string
  unit: string | null
  quantity: string
  unit_price_cents: string
  amount_cents: string
}

type Params = { company: string; order?: string }

const TOTALS = `(select count(*)::int as line_count,
      coalesce(sum(round(l.quantity * l.unit_price_cents)), 0)::bigint::text as total_cents
    from public.purchase_order_lines l where l.order_id = o.id)`

const SELECT = `select o.id, o.number_year, o.number_seq, o.status, o.supplier_id,
    p.name as supplier_name, o.site_id, s.name as site_name, s.code as site_code,
    o.order_date::text as order_date, o.delivery_date::text as delivery_date, o.notes,
    t.line_count, t.total_cents, o.sent_at, o.received_at, o.version, o.created_at, o.updated_at
  from public.purchase_orders o
  join public.suppliers p on p.id = o.supplier_id
  left join public.sites s on s.id = o.site_id
  cross join lateral ${TOTALS} t`

const SORTS = {
  date: 'o.order_date asc, o.number_year asc, o.number_seq asc',
  '-date': 'o.order_date desc, o.number_year desc, o.number_seq desc',
  number: 'o.number_year asc, o.number_seq asc',
  '-number': 'o.number_year desc, o.number_seq desc',
  total: 't.total_cents::bigint asc, o.id asc',
  '-total': 't.total_cents::bigint desc, o.id desc',
} as const

function summary(row: OrderRow) {
  return {
    id: row.id,
    number: `${row.number_year}/${String(row.number_seq).padStart(3, '0')}`,
    status: row.status,
    supplier_id: row.supplier_id,
    supplier: { id: row.supplier_id, name: row.supplier_name },
    site_id: row.site_id,
    site: row.site_id ? { id: row.site_id, name: row.site_name ?? '', code: row.site_code } : null,
    date: row.order_date,
    delivery_date: row.delivery_date,
    notes: row.notes,
    line_count: row.line_count,
    total: centsToAmount(row.total_cents),
    sent_at: row.sent_at?.toISOString() ?? null,
    received_at: row.received_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

interface FullOrder {
  row: OrderRow
  lines: LineRow[]
}

function send(reply: FastifyReply, order: FullOrder, status = 200) {
  return reply
    .code(status)
    .header('ETag', `"${order.row.version}"`)
    .send({
      ...summary(order.row),
      lines: order.lines.map((l) => ({
        description: l.description,
        unit: l.unit,
        quantity: l.quantity,
        unit_price: centsToAmount(l.unit_price_cents),
        amount: centsToAmount(l.amount_cents),
      })),
    })
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.orderMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseOrderInput(body: unknown): OrderInput {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const textOf = (raw: Record<string, unknown>, field: string, key: string, max: number) => {
    if (!(key in raw)) {
      add(field, 'Campo mancante.')
      return null
    }
    const value = raw[key]
    if (value === null) return null
    if (typeof value !== 'string') {
      add(field, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) add(field, `Al massimo ${max} caratteri.`)
    return trimmed === '' ? null : trimmed
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number) => textOf(raw, field, field, max)
  const supplier_id = text('supplier_id', 36)
  if (supplier_id === null && !errors.supplier_id) add('supplier_id', 'Scegli il fornitore.')
  else if (supplier_id !== null && !UUID.test(supplier_id)) {
    add('supplier_id', 'Fornitore non trovato.')
  }
  const site_id = text('site_id', 36)
  if (site_id !== null && !errors.site_id && !UUID.test(site_id)) {
    add('site_id', 'Cantiere non trovato.')
  }
  const date = text('date', 10)
  if (date === null && !errors.date) add('date', 'Indica la data dell’ordine.')
  else if (date !== null && !errors.date && !isIsoDate(date)) {
    add('date', 'Data non valida (AAAA-MM-GG).')
  }
  const delivery_date = text('delivery_date', 10)
  if (delivery_date !== null && !errors.delivery_date) {
    if (!isIsoDate(delivery_date)) add('delivery_date', 'Data non valida (AAAA-MM-GG).')
    else if (date !== null && !errors.date && delivery_date < date) {
      add('delivery_date', 'La consegna non può essere prima della data dell’ordine.')
    }
  }
  const notes = text('notes', 2000)
  const lines: LineInput[] = []
  if (!('lines' in raw)) add('lines', 'Campo mancante.')
  else if (!Array.isArray(raw.lines)) add('lines', 'Deve essere un elenco.')
  else if (raw.lines.length > MAX_LINES) add('lines', `Al massimo ${MAX_LINES} righe.`)
  else {
    raw.lines.forEach((item: unknown, i) => {
      const prefix = `lines.${i}`
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        add(prefix, 'Ogni riga deve essere un oggetto.')
        return
      }
      const line = item as Record<string, unknown>
      const description = textOf(line, `${prefix}.description`, 'description', 500)
      if (description === null && !errors[`${prefix}.description`]) {
        add(`${prefix}.description`, 'Descrivi la riga.')
      }
      const unit = textOf(line, `${prefix}.unit`, 'unit', 20)
      const quantity = textOf(line, `${prefix}.quantity`, 'quantity', 20)
      if (!errors[`${prefix}.quantity`]) {
        if (quantity === null || !QUANTITY.test(quantity) || /^[0.]+$/.test(quantity)) {
          add(
            `${prefix}.quantity`,
            'Una quantità maggiore di zero, con il punto e al massimo tre decimali.',
          )
        }
      }
      const price = textOf(line, `${prefix}.unit_price`, 'unit_price', 20)
      const cents = price === null ? null : amountToCents(price)
      if (cents === null && !errors[`${prefix}.unit_price`]) {
        add(
          `${prefix}.unit_price`,
          'Un importo come 1234.50, con il punto e al massimo due decimali.',
        )
      }
      if (
        quantity &&
        cents &&
        !errors[`${prefix}.quantity`] &&
        lineCents(quantity, cents) > MAX_LINE_CENTS
      ) {
        add(`${prefix}.unit_price`, 'Importo della riga troppo alto.')
      }
      if (description && quantity && cents && !errors[`${prefix}.unit_price`]) {
        lines.push({ description, unit, quantity, unit_price_cents: cents })
      }
    })
  }
  if (Object.keys(errors).length > 0 || !supplier_id || !date) {
    throw new ValidationFailed(errors)
  }
  return { supplier_id, site_id, date, delivery_date, notes, lines }
}

/** Supplier and site must be of the company: errors under their own field. */
async function checkReferences(client: PoolClient, input: OrderInput) {
  const errors: FieldErrors = {}
  const supplier = await client.query('select 1 from public.suppliers where id = $1', [
    input.supplier_id,
  ])
  if (!supplier.rowCount) errors.supplier_id = ['Fornitore non trovato.']
  if (input.site_id) {
    const site = await client.query('select 1 from public.sites where id = $1', [input.site_id])
    if (!site.rowCount) errors.site_id = ['Cantiere non trovato.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
}

function writeFailed(error: unknown): never {
  // A supplier or site deleted between the check and the write.
  if (isForeignKeyViolation(error)) {
    throw new ValidationFailed({ supplier_id: ['Fornitore o cantiere non trovato.'] })
  }
  throw error
}

async function writeLines(client: PoolClient, id: string, lines: LineInput[]) {
  await client.query('delete from public.purchase_order_lines where order_id = $1', [id])
  if (lines.length === 0) return
  await client.query(
    `insert into public.purchase_order_lines
       (company_id, order_id, position, description, unit, quantity, unit_price_cents)
     select app.current_company_id(), $1, x.position, x.description, x.unit, x.quantity, x.price
     from unnest($2::int[], $3::text[], $4::text[], $5::numeric[], $6::bigint[])
       as x(position, description, unit, quantity, price)`,
    [
      id,
      lines.map((_, i) => i),
      lines.map((l) => l.description),
      lines.map((l) => l.unit),
      lines.map((l) => l.quantity),
      lines.map((l) => l.unit_price_cents),
    ],
  )
}

async function readOne(client: PoolClient, id: string): Promise<FullOrder | undefined> {
  const { rows } = await client.query<OrderRow>(`${SELECT} where o.id = $1`, [id])
  const row = rows[0]
  if (!row) return undefined
  const lines = await client.query<LineRow>(
    `select description, unit, quantity::text as quantity,
       unit_price_cents::text as unit_price_cents,
       round(quantity * unit_price_cents)::bigint::text as amount_cents
     from public.purchase_order_lines where order_id = $1 order by position`,
    [id],
  )
  return { row, lines: lines.rows }
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.orderStale, 'stale_record')
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
  const sortValue = single('sort') ?? '-date'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const statusValue = single('filter[status]')
  const status = ORDER_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const supplierId = id('filter[supplier]')
  const siteId = id('filter[site]')
  const from = date('filter[from]')
  const to = date('filter[to]')
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-date', status, supplierId, siteId, from, to }
}

export function purchaseOrderRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/purchase-orders'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.view')) throw forbidden()
      const where = ['true']
      const values: unknown[] = []
      const add = (sql: (p: string) => string, value: unknown) => {
        values.push(value)
        where.push(sql(`$${values.length}`))
      }
      if (list.status) add((p) => `o.status = ${p}`, list.status)
      if (list.supplierId) add((p) => `o.supplier_id = ${p}`, list.supplierId)
      if (list.siteId) add((p) => `o.site_id = ${p}`, list.siteId)
      if (list.from) add((p) => `o.order_date >= ${p}`, list.from)
      if (list.to) add((p) => `o.order_date <= ${p}`, list.to)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<OrderRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number; amount: string }>(
        `select count(*)::int as total, coalesce(sum(t.total_cents::bigint), 0)::text as amount
         from public.purchase_orders o cross join lateral ${TOTALS} t
         where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      return {
        data: rows.map(summary),
        meta: { total: count.rows[0]?.total ?? 0, page: list.page, per_page: list.perPage },
        total_amount: centsToAmount(count.rows[0]?.amount ?? '0'),
      }
    })
  })

  app.get<{ Params: Params }>(`${base}/:order`, async (request, reply) => {
    const session = requireSession(request)
    const order = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.view')) throw notFound()
      const id = request.params.order ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!order) throw notFound()
    return send(reply, order)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const order = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.create')) throw forbidden()
      const input = parseOrderInput(request.body)
      await checkReferences(client, input)
      // One numbering per company and year: concurrent creations wait for each other.
      await client.query(
        `select pg_advisory_xact_lock(hashtext('purchase_orders:' || app.current_company_id()))`,
      )
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
             site_id, order_date, delivery_date, notes)
           select app.current_company_id(), extract(year from $3::date)::int,
             coalesce(max(number_seq), 0) + 1, $1, $2, $3, $4, $5
           from public.purchase_orders
           where number_year = extract(year from $3::date)::int
           returning id`,
          [input.supplier_id, input.site_id, input.date, input.delivery_date, input.notes],
        )
        .catch(writeFailed)
      const id = rows[0]?.id ?? ''
      await writeLines(client, id, input.lines)
      return readOne(client, id)
    })
    if (!order) throw new Error('insert returned no row')
    return send(reply, order, 201)
  })

  app.put<{ Params: Params }>(`${base}/:order`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const order = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.update')) throw forbidden()
      const id = request.params.order ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseOrderInput(request.body)
      const current = await readOne(client, id)
      if (!current) throw notFound()
      if (current.row.version !== version) {
        throw new ApiError(412, messages.orderStale, 'stale_record')
      }
      if (current.row.status !== 'draft') {
        throw new ApiError(409, messages.orderNotDraft, 'order_not_draft')
      }
      await checkReferences(client, input)
      const { rowCount } = await client
        .query(
          `update public.purchase_orders
           set supplier_id = $1, site_id = $2, order_date = $3, delivery_date = $4, notes = $5,
               version = version + 1, updated_at = now()
           where id = $6 and version = $7 and status = 'draft'`,
          [
            input.supplier_id,
            input.site_id,
            input.date,
            input.delivery_date,
            input.notes,
            id,
            version,
          ],
        )
        .catch(writeFailed)
      if (!rowCount) return missingOrStale(client, id)
      await writeLines(client, id, input.lines)
      return readOne(client, id)
    })
    if (!order) throw notFound()
    return send(reply, order)
  })

  app.post<{ Params: Params }>(`${base}/:order/status`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const order = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.update')) throw forbidden()
      const id = request.params.order ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const body = request.body as Record<string, unknown> | null
      const target = ORDER_STATUSES.find((s) => s === body?.status)
      if (!target) throw new ValidationFailed({ status: ['Stato non valido.'] })
      const current = await readOne(client, id)
      if (!current) throw notFound()
      if (current.row.version !== version) {
        throw new ApiError(412, messages.orderStale, 'stale_record')
      }
      const from = current.row.status
      const allowed =
        (from === 'draft' && target === 'sent') ||
        (from === 'sent' && target === 'received') ||
        (from === 'sent' && target === 'draft') ||
        (from === 'received' && target === 'sent')
      if (!allowed) {
        throw new ApiError(409, messages.orderInvalidTransition, 'invalid_transition')
      }
      if (from === 'received') {
        // Locked first, so a load written at the same time is seen.
        await client.query('select 1 from public.purchase_orders where id = $1 for update', [id])
        const loads = await client.query(
          'select 1 from public.warehouse_movements where purchase_order_id = $1 limit 1',
          [id],
        )
        if (loads.rowCount) throw new ApiError(409, messages.orderLoaded, 'has_documents')
      }
      if (target === 'sent' && current.lines.length === 0) {
        throw new ValidationFailed({ lines: ['Aggiungi almeno una riga prima di inviarlo.'] })
      }
      const { rowCount } = await client.query(
        `update public.purchase_orders
         set status = $1,
             sent_at = case when $1 = 'draft' then null
                            when $1 = 'sent' and sent_at is null then now() else sent_at end,
             received_at = case when $1 = 'received' then now() else null end,
             version = version + 1, updated_at = now()
         where id = $2 and version = $3`,
        [target, id, version],
      )
      if (!rowCount) return missingOrStale(client, id)
      return readOne(client, id)
    })
    if (!order) throw notFound()
    return send(reply, order)
  })

  app.delete<{ Params: Params }>(`${base}/:order`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('purchases.delete')) throw forbidden()
      const id = request.params.order ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        "delete from public.purchase_orders where id = $1 and version = $2 and status = 'draft'",
        [id, version],
      )
      if (rowCount) return
      const current = await readOne(client, id)
      if (current && current.row.version === version) {
        throw new ApiError(409, messages.orderNotDraft, 'order_not_draft')
      }
      await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
