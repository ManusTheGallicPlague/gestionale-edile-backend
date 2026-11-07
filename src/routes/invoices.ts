import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
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
import {
  ATTACHMENT_JSON,
  ATTACHMENT_TYPES,
  sendAttachment,
  uploadScope,
  type AttachmentInfo,
} from '../http/files.js'
import { cleanFileName, matchesType } from './site-documents.js'
import { MAX_EXPORT_ROWS, italianAmount, italianDate, toCsv } from '../csv.js'
import { isVatNature, type VatNature } from '../quotes/vat.js'

export const DIRECTIONS = ['issued', 'received'] as const
type Direction = (typeof DIRECTIONS)[number]
const PAYMENT_STATUSES = ['open', 'overdue', 'paid'] as const
type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/** Taxable and VAT stay below 10^13 cents each, so the total fits the database check. */
const MAX_CENTS = 10n ** 13n

interface InvoiceInput {
  direction: Direction
  number: string
  date: string
  client_id: string | null
  supplier_id: string | null
  site_id: string | null
  description: string | null
  taxable_cents: string
  vat_cents: string
  /** undefined when absent: null on creation, unchanged on update (if VAT stays zero). */
  vat_nature: VatNature | null | undefined
  /** undefined when absent: null on creation, unchanged on update. */
  progress_statement_id: string | null | undefined
  /** undefined when absent: 0 on creation, unchanged on update. */
  withholding_cents: string | undefined
  due_date: string | null
  paid_on: string | null
  notes: string | null
}

interface InvoiceRow {
  id: string
  direction: Direction
  number: string
  invoice_date: string
  client_id: string | null
  client_name: string | null
  supplier_id: string | null
  supplier_name: string | null
  site_id: string | null
  site_name: string | null
  site_code: string | null
  description: string | null
  taxable_cents: string
  vat_cents: string
  vat_nature: VatNature | null
  progress_statement_id: string | null
  total_cents: string
  withholding_cents: string
  due_cents: string
  due_date: string | null
  paid_on: string | null
  payment_status: PaymentStatus
  deadline_id: string | null
  file: AttachmentInfo | null
  notes: string | null
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; invoice?: string }

const STATUS_LABELS: Record<PaymentStatus, string> = {
  open: 'Da pagare',
  overdue: 'Scaduta',
  paid: 'Pagata',
}

// "Today" is the Italian one, not the server's.
const PAYMENT_STATUS = `case
    when i.paid_on is not null then 'paid'
    when i.due_date < (now() at time zone 'Europe/Rome')::date then 'overdue'
    else 'open'
  end`

const SELECT = `select i.id, i.direction, i.number, i.invoice_date::text as invoice_date,
    i.client_id, c.name as client_name, i.supplier_id, p.name as supplier_name,
    i.site_id, s.name as site_name, s.code as site_code, i.description,
    i.taxable_cents::text as taxable_cents, i.vat_cents::text as vat_cents,
    i.vat_nature, i.progress_statement_id, (i.taxable_cents + i.vat_cents)::text as total_cents,
    i.withholding_cents::text as withholding_cents,
    (i.taxable_cents + i.vat_cents - i.withholding_cents)::text as due_cents,
    i.due_date::text as due_date, i.paid_on::text as paid_on,
    ${PAYMENT_STATUS} as payment_status, d.id as deadline_id,
    (select ${ATTACHMENT_JSON} from public.invoice_files f where f.invoice_id = i.id) as file,
    i.notes, i.version, i.created_at, i.updated_at
  from public.invoices i
  left join public.clients c on c.id = i.client_id
  left join public.suppliers p on p.id = i.supplier_id
  left join public.sites s on s.id = i.site_id
  left join public.deadlines d on d.invoice_id = i.id`

const SORTS = {
  date: 'i.invoice_date asc, i.created_at asc, i.id asc',
  '-date': 'i.invoice_date desc, i.created_at desc, i.id desc',
  due_date: 'i.due_date asc nulls last, i.id asc',
  '-due_date': 'i.due_date desc nulls last, i.id desc',
  total: '(i.taxable_cents + i.vat_cents) asc, i.id asc',
  '-total': '(i.taxable_cents + i.vat_cents) desc, i.id desc',
} as const

function toContract(row: InvoiceRow) {
  return {
    id: row.id,
    direction: row.direction,
    number: row.number,
    date: row.invoice_date,
    client_id: row.client_id,
    client: row.client_id ? { id: row.client_id, name: row.client_name ?? '' } : null,
    supplier_id: row.supplier_id,
    supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? '' } : null,
    site_id: row.site_id,
    site: row.site_id ? { id: row.site_id, name: row.site_name ?? '', code: row.site_code } : null,
    description: row.description,
    taxable_amount: centsToAmount(row.taxable_cents),
    vat_amount: centsToAmount(row.vat_cents),
    vat_nature: row.vat_nature,
    progress_statement_id: row.progress_statement_id,
    total: centsToAmount(row.total_cents),
    withholding_amount: centsToAmount(row.withholding_cents),
    amount_due: centsToAmount(row.due_cents),
    due_date: row.due_date,
    paid_on: row.paid_on,
    payment_status: row.payment_status,
    deadline_id: row.deadline_id,
    file: row.file,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: InvoiceRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.invoiceMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseInvoiceInput(body: unknown): InvoiceInput {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number) => {
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
  const id = (field: string, message: string) => {
    const value = text(field, 36)
    if (value !== null && !errors[field] && !UUID.test(value)) add(field, message)
    return value
  }
  const date = (field: string) => {
    const value = text(field, 10)
    if (value !== null && !errors[field] && !isIsoDate(value)) {
      add(field, 'Data non valida (AAAA-MM-GG).')
    }
    return value
  }
  const amount = (field: string) => {
    const value = text(field, 20)
    if (errors[field]) return null
    const cents = value === null ? null : amountToCents(value)
    if (cents === null) {
      add(field, 'Un importo come 1234.50, con il punto e al massimo due decimali.')
    } else if (BigInt(cents) >= MAX_CENTS) {
      add(field, 'Importo troppo alto.')
      return null
    }
    return cents
  }

  const directionValue = raw.direction
  const direction = DIRECTIONS.find((d) => d === directionValue)
  if (!('direction' in raw)) add('direction', 'Campo mancante.')
  else if (!direction) add('direction', 'Indica se la fattura è emessa o ricevuta.')
  const number = text('number', 40)
  if (number === null && !errors.number) add('number', 'Indica il numero della fattura.')
  const invoiceDate = date('date')
  if (invoiceDate === null && !errors.date) add('date', 'Indica la data della fattura.')
  const client_id = id('client_id', 'Cliente non trovato.')
  const supplier_id = id('supplier_id', 'Fornitore non trovato.')
  if (direction === 'issued') {
    if (client_id === null && !errors.client_id) add('client_id', 'Scegli il cliente.')
    if (supplier_id !== null && !errors.supplier_id) {
      add('supplier_id', 'Una fattura emessa non ha un fornitore.')
    }
  } else if (direction === 'received') {
    if (supplier_id === null && !errors.supplier_id) add('supplier_id', 'Scegli il fornitore.')
    if (client_id !== null && !errors.client_id) {
      add('client_id', 'Una fattura ricevuta non ha un cliente.')
    }
  }
  const site_id = id('site_id', 'Cantiere non trovato.')
  const description = text('description', 500)
  const taxable_cents = amount('taxable_amount')
  const vat_cents = amount('vat_amount')
  let vat_nature: VatNature | null | undefined
  if ('vat_nature' in raw && raw.vat_nature !== undefined) {
    if (raw.vat_nature === null) vat_nature = null
    else if (!isVatNature(raw.vat_nature)) {
      add('vat_nature', 'Natura IVA non valida: un codice come N6.3.')
    } else if (vat_cents !== null && vat_cents !== '0') {
      add('vat_nature', 'La natura IVA si indica solo senza IVA (0.00).')
    } else vat_nature = raw.vat_nature
  }
  let progress_statement_id: string | null | undefined
  if ('progress_statement_id' in raw && raw.progress_statement_id !== undefined) {
    progress_statement_id = id('progress_statement_id', 'SAL non trovato.')
    if (progress_statement_id !== null && direction === 'received') {
      add('progress_statement_id', 'Si collega un SAL solo a una fattura emessa.')
    }
  }
  let withholding_cents: string | undefined
  if ('withholding_amount' in raw && raw.withholding_amount !== undefined) {
    withholding_cents = amount('withholding_amount') ?? undefined
    if (withholding_cents !== undefined && taxable_cents !== null) {
      const message = withholdingError(withholding_cents, taxable_cents)
      if (message) add('withholding_amount', message)
    }
  }
  const due_date = date('due_date')
  if (
    due_date !== null &&
    invoiceDate !== null &&
    !errors.due_date &&
    !errors.date &&
    due_date < invoiceDate
  ) {
    add('due_date', 'La scadenza di pagamento non può essere prima della data della fattura.')
  }
  const paid_on = date('paid_on')
  const notes = text('notes', 2000)
  if (
    Object.keys(errors).length > 0 ||
    !direction ||
    !number ||
    !invoiceDate ||
    taxable_cents === null ||
    vat_cents === null
  ) {
    throw new ValidationFailed(errors)
  }
  return {
    direction,
    number,
    date: invoiceDate,
    client_id,
    supplier_id,
    site_id,
    description,
    taxable_cents,
    vat_cents,
    vat_nature,
    progress_statement_id,
    withholding_cents,
    due_date,
    paid_on,
    notes,
  }
}

/** The withholding is taken on the taxable amount, so it never goes beyond it. */
function withholdingError(withholding: string, taxable: string): string | null {
  return BigInt(withholding) > BigInt(taxable)
    ? "La ritenuta d'acconto non può superare l'imponibile."
    : null
}

/** Client, supplier and site must be of the company: errors under their own field. */
async function checkReferences(client: PoolClient, input: InvoiceInput) {
  const errors: FieldErrors = {}
  const check = async (table: string, value: string | null, field: string, message: string) => {
    if (!value) return
    const { rowCount } = await client.query(`select 1 from public.${table} where id = $1`, [value])
    if (!rowCount) errors[field] = [message]
  }
  await check('clients', input.client_id, 'client_id', 'Cliente non trovato.')
  await check('suppliers', input.supplier_id, 'supplier_id', 'Fornitore non trovato.')
  await check('sites', input.site_id, 'site_id', 'Cantiere non trovato.')
  if (input.progress_statement_id) {
    const { rows } = await client.query<{ status: string; site_id: string | null }>(
      `select ps.status, e.site_id from public.progress_statements ps
       join public.estimates e on e.id = ps.estimate_id where ps.id = $1`,
      [input.progress_statement_id],
    )
    const statement = rows[0]
    const field = 'progress_statement_id'
    if (!statement) errors[field] = ['SAL non trovato.']
    else if (statement.status !== 'approved') errors[field] = ['Si fattura solo un SAL approvato.']
    else if (input.site_id && statement.site_id !== input.site_id) {
      errors[field] = ['Il SAL è di un altro cantiere.']
    }
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
}

function writeFailed(error: unknown): never {
  if (isUniqueViolation(error) && error.constraint === 'invoices_progress_statement_idx') {
    throw new ValidationFailed({
      progress_statement_id: ['Questo SAL è già stato fatturato.'],
    })
  }
  if (isUniqueViolation(error)) {
    throw new ValidationFailed({
      number: ['Questo numero è già stato registrato per lo stesso anno.'],
    })
  }
  // A client, supplier or site deleted between the check and the write.
  if (isForeignKeyViolation(error)) {
    throw new ValidationFailed({ _: ['Cliente, fornitore o cantiere non trovato.'] })
  }
  throw error
}

/**
 * Keeps the invoice's deadline in step: one deadline on the payment due date, with the total
 * and the client or supplier, done while the invoice is paid; none without a due date.
 */
async function syncDeadline(client: PoolClient, invoiceId: string): Promise<void> {
  await client.query(
    `delete from public.deadlines d using public.invoices i
     where d.invoice_id = i.id and i.id = $1 and i.due_date is null`,
    [invoiceId],
  )
  await client.query(
    `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, client_id,
       supplier_id, status, done_at, invoice_id)
     select i.company_id, left('Fattura ' || i.number || ' – ' || coalesce(c.name, p.name), 200),
       i.due_date, case i.direction when 'issued' then 'invoice_out' else 'invoice_in' end,
       i.taxable_cents + i.vat_cents - i.withholding_cents, i.client_id, i.supplier_id,
       case when i.paid_on is null then 'open' else 'done' end,
       case when i.paid_on is not null then now() end, i.id
     from public.invoices i
     left join public.clients c on c.id = i.client_id
     left join public.suppliers p on p.id = i.supplier_id
     where i.id = $1 and i.due_date is not null
     on conflict (invoice_id) do update set
       title = excluded.title, due_on = excluded.due_on, kind = excluded.kind,
       amount_cents = excluded.amount_cents, client_id = excluded.client_id,
       supplier_id = excluded.supplier_id, status = excluded.status,
       done_at = case when excluded.status = 'open' then null
                      else coalesce(deadlines.done_at, excluded.done_at) end,
       version = deadlines.version + 1, updated_at = now()`,
    [invoiceId],
  )
}

async function readOne(client: PoolClient, id: string): Promise<InvoiceRow | undefined> {
  const { rows } = await client.query<InvoiceRow>(`${SELECT} where i.id = $1`, [id])
  return rows[0]
}

async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  if (!(await readOne(client, id))) throw notFound()
  throw new ApiError(412, messages.invoiceStale, 'stale_record')
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
  const directionValue = single('filter[direction]')
  const direction = DIRECTIONS.find((d) => d === directionValue)
  if (directionValue !== undefined && !direction) {
    errors['filter[direction]'] = ['Valori ammessi: issued, received.']
  }
  const statusValue = single('filter[status]')
  const status = PAYMENT_STATUSES.find((s) => s === statusValue)
  if (statusValue !== undefined && !status) errors['filter[status]'] = ['Stato non valido.']
  const clientId = id('filter[client]')
  const supplierId = id('filter[supplier]')
  const siteId = id('filter[site]')
  const from = date('filter[from]')
  const to = date('filter[to]')
  const qValue = single('filter[q]')?.trim()
  if (qValue !== undefined && qValue.length > 100)
    errors['filter[q]'] = ['Al massimo 100 caratteri.']
  const q = qValue ? qValue : undefined
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    page,
    perPage,
    sort: sort ?? '-date',
    direction,
    status,
    clientId,
    supplierId,
    siteId,
    from,
    to,
    q,
  }
}

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.direction) add((p) => `i.direction = ${p}`, list.direction)
  if (list.status) add((p) => `${PAYMENT_STATUS} = ${p}`, list.status)
  if (list.clientId) add((p) => `i.client_id = ${p}`, list.clientId)
  if (list.supplierId) add((p) => `i.supplier_id = ${p}`, list.supplierId)
  if (list.siteId) add((p) => `i.site_id = ${p}`, list.siteId)
  if (list.from) add((p) => `i.invoice_date >= ${p}`, list.from)
  if (list.to) add((p) => `i.invoice_date <= ${p}`, list.to)
  if (list.q) {
    add(
      (p) => `strpos(lower(i.number || ' ' || coalesce(i.description, '')), lower(${p})) > 0`,
      list.q,
    )
  }
  return { where, values }
}

export function invoiceRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/invoices'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<InvoiceRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number; amount: string; outstanding: string }>(
        `select count(*)::int as total,
           coalesce(sum(i.taxable_cents + i.vat_cents), 0)::text as amount,
           coalesce(sum(i.taxable_cents + i.vat_cents - i.withholding_cents)
             filter (where i.paid_on is null), 0)::text as outstanding
         from public.invoices i where ${where.join(' and ')}`,
        values.slice(0, filters),
      )
      const totals = count.rows[0]
      return {
        data: rows.map(toContract),
        meta: { total: totals?.total ?? 0, page: list.page, per_page: list.perPage },
        total_amount: centsToAmount(totals?.amount ?? '0'),
        outstanding_amount: centsToAmount(totals?.outstanding ?? '0'),
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
        if (!permissions.has('invoices.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<InvoiceRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Tipo',
            'Numero',
            'Data',
            'Cliente o fornitore',
            'Cantiere',
            'Descrizione',
            'Imponibile',
            'IVA',
            'Natura IVA',
            'Totale',
            "Ritenuta d'acconto",
            'Netto a pagare',
            'Scadenza pagamento',
            'Pagata il',
            'Stato',
            'Note',
          ],
          rows.map((r) => [
            r.direction === 'issued' ? 'Emessa' : 'Ricevuta',
            r.number,
            italianDate(r.invoice_date),
            r.client_name ?? r.supplier_name,
            r.site_name,
            r.description,
            italianAmount(r.taxable_cents),
            italianAmount(r.vat_cents),
            r.vat_nature,
            italianAmount(r.total_cents),
            italianAmount(r.withholding_cents),
            italianAmount(r.due_cents),
            r.due_date === null ? null : italianDate(r.due_date),
            r.paid_on === null ? null : italianDate(r.paid_on),
            STATUS_LABELS[r.payment_status],
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="fatture.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:invoice`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.view')) throw notFound()
      const id = request.params.invoice ?? ''
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
      if (!permissions.has('invoices.create')) throw forbidden()
      const input = parseInvoiceInput(request.body)
      await checkReferences(client, input)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
             supplier_id, site_id, description, taxable_cents, vat_cents, due_date, paid_on, notes,
             vat_nature, progress_statement_id, withholding_cents)
           values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15)
           returning id`,
          [
            input.direction,
            input.number,
            input.date,
            input.client_id,
            input.supplier_id,
            input.site_id,
            input.description,
            input.taxable_cents,
            input.vat_cents,
            input.due_date,
            input.paid_on,
            input.notes,
            input.vat_nature ?? null,
            input.progress_statement_id ?? null,
            input.withholding_cents ?? '0',
          ],
        )
        .catch(writeFailed)
      const id = rows[0]?.id ?? ''
      await syncDeadline(client, id)
      return readOne(client, id)
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:invoice`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.update')) throw forbidden()
      const id = request.params.invoice ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseInvoiceInput(request.body)
      const current = await readOne(client, id)
      if (!current) throw notFound()
      // Absent: the link stays, and is checked again against the new direction and site.
      if (input.progress_statement_id === undefined) {
        input.progress_statement_id = current.progress_statement_id
        if (current.progress_statement_id && input.direction === 'received') {
          throw new ValidationFailed({
            progress_statement_id: ['Si collega un SAL solo a una fattura emessa.'],
          })
        }
      }
      // Absent: the withholding stays, if it still fits the new taxable amount.
      if (input.withholding_cents === undefined) {
        input.withholding_cents = current.withholding_cents
        const message = withholdingError(current.withholding_cents, input.taxable_cents)
        if (message) throw new ValidationFailed({ withholding_amount: [message] })
      }
      await checkReferences(client, input)
      const { rowCount } = await client
        .query(
          `update public.invoices
           set direction = $1, number = $2, invoice_date = $3, client_id = $4, supplier_id = $5,
               site_id = $6, description = $7, taxable_cents = $8, vat_cents = $9,
               due_date = $10, paid_on = $11, notes = $12,
               vat_nature = case when $9::bigint <> 0 then null
                                 when $16::boolean then $15::text else vat_nature end,
               progress_statement_id = $17, withholding_cents = $18,
               version = version + 1, updated_at = now()
           where id = $13 and version = $14`,
          [
            input.direction,
            input.number,
            input.date,
            input.client_id,
            input.supplier_id,
            input.site_id,
            input.description,
            input.taxable_cents,
            input.vat_cents,
            input.due_date,
            input.paid_on,
            input.notes,
            id,
            version,
            input.vat_nature ?? null,
            input.vat_nature !== undefined,
            input.progress_statement_id,
            input.withholding_cents,
          ],
        )
        .catch(writeFailed)
      if (!rowCount) return missingOrStale(client, id)
      await syncDeadline(client, id)
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:invoice`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.delete')) throw forbidden()
      const id = request.params.invoice ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.invoices where id = $1 and version = $2',
        [id, version],
      )
      if (!rowCount) await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })

  /** Takes the next version of the invoice, or answers 404/412 as the other writes do. */
  const bumpVersion = async (client: PoolClient, id: string, version: number) => {
    const { rowCount } = await client.query(
      `update public.invoices set version = version + 1, updated_at = now()
       where id = $1 and version = $2`,
      [id, version],
    )
    if (!rowCount) await missingOrStale(client, id)
  }

  app.get<{ Params: Params }>(`${base}/:invoice/file`, async (request, reply) => {
    const session = requireSession(request)
    const file = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.view')) throw notFound()
      const id = request.params.invoice ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<{
        file_name: string
        content_type: string
        data: Buffer
        version: number
      }>(
        `select f.file_name, f.content_type, f.data, i.version
         from public.invoice_files f join public.invoices i on i.id = f.invoice_id
         where i.id = $1`,
        [id],
      )
      if (!rows[0]) throw notFound()
      return rows[0]
    })
    return sendAttachment(reply, file)
  })

  app.delete<{ Params: Params }>(`${base}/:invoice/file`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('invoices.update')) throw forbidden()
      const id = request.params.invoice ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      await bumpVersion(client, id, version)
      const { rowCount } = await client.query(
        'delete from public.invoice_files where invoice_id = $1',
        [id],
      )
      // No file: the error rolls the version back.
      if (!rowCount) throw notFound()
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  uploadScope(app, config, (scope) => {
    scope.put<{ Params: Params; Querystring: Record<string, unknown> }>(
      `${base}/:invoice/file`,
      async (request, reply) => {
        const session = requireSession(request)
        checkCsrf(config, request)
        const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has('invoices.update')) throw forbidden()
          const id = request.params.invoice ?? ''
          if (!UUID.test(id)) throw notFound()
          const version = expectedVersion(request.headers['if-match'])
          const rawName = request.query.file_name
          const fileName = typeof rawName === 'string' ? cleanFileName(rawName) : null
          if (fileName === null || fileName.length > 200) {
            throw new ValidationFailed({
              file_name: [
                fileName === null ? 'Indica il nome del file.' : 'Al massimo 200 caratteri.',
              ],
            })
          }
          const body = request.body
          const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim()
          const type = ATTACHMENT_TYPES.find((t) => t === declared)
          if (!Buffer.isBuffer(body) || body.length === 0 || !type || !matchesType(body, type)) {
            throw new ValidationFailed({
              file: ['Il file non corrisponde al suo tipo, oppure è vuoto.'],
            })
          }
          await bumpVersion(client, id, version)
          await client.query('delete from public.invoice_files where invoice_id = $1', [id])
          await client.query(
            `insert into public.invoice_files
               (invoice_id, company_id, file_name, content_type, size_bytes, data)
             values ($1, app.current_company_id(), $2, $3, $4, $5)`,
            [id, fileName, type, body.length, body],
          )
          return readOne(client, id)
        })
        if (!row) throw notFound()
        return send(reply, row)
      },
    )
  })
}
