import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { amountToCents, centsToAmount } from '../money.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { VAT_RATES, isVatNature, type VatNature } from '../quotes/vat.js'
import { italianAmount, toCsv } from '../csv.js'
import { formatQuoteNumber } from '../quotes/number.js'

const KINDS = ['item', 'text', 'section'] as const
const KIND_LABELS = { item: 'Voce', text: 'Testo', section: 'Sezione' } as const
const QUANTITY = /^-?\d{1,11}(?:\.\d{1,3})?$/
const PERCENT = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/

type Params = { company: string; quote: string; line?: string }

interface LineInput {
  kind: (typeof KINDS)[number]
  description: string
  unit: string | null
  quantity: string | null
  unitPriceCents: string | null
  discount: string | null
  vatRate: number | null
  vatNature: VatNature | null
}

export interface LineRow {
  id: string
  kind: LineInput['kind']
  description: string
  unit: string | null
  quantity: string | null
  unit_price_cents: string | null
  discount_percent: string | null
  vat_rate: number | null
  vat_nature: VatNature | null
  amount_cents: string | null
  position: number
  version: number
}

export const LINE_COLUMNS = `id, kind, description, unit, quantity::text as quantity,
  unit_price_cents::text as unit_price_cents, discount_percent::text as discount_percent,
  vat_rate, vat_nature, position, version,
  round(quantity * unit_price_cents * (100 - discount_percent) / 100)::text as amount_cents`

export const lineToContract = (row: LineRow) => ({
  id: row.id,
  kind: row.kind,
  description: row.description,
  unit: row.unit,
  quantity: row.quantity,
  unit_price: row.unit_price_cents === null ? null : centsToAmount(row.unit_price_cents),
  discount_percent: row.discount_percent,
  vat_rate: row.vat_rate,
  vat_nature: row.vat_nature,
  amount: row.amount_cents === null ? null : centsToAmount(row.amount_cents),
  position: row.position,
  version: `"${row.version}"`,
})

const sendLine = (reply: FastifyReply, row: LineRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(lineToContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.quoteMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseLine(body: unknown): LineInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  for (const field of [
    'kind',
    'description',
    'unit',
    'quantity',
    'unit_price',
    'discount_percent',
    'vat_rate',
  ]) {
    if (!(field in raw)) add(field, 'Campo mancante.')
  }
  const kind = KINDS.find((k) => k === raw.kind)
  if (!kind && !errors.kind) add('kind', 'Tipo di riga non valido.')
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!errors.description && description === '')
    add('description', 'La descrizione è obbligatoria.')
  if (description.length > 5000) add('description', 'Al massimo 5000 caratteri.')

  const input: LineInput = {
    kind: kind ?? 'text',
    description,
    unit: null,
    quantity: null,
    unitPriceCents: null,
    discount: null,
    vatRate: null,
    vatNature: null,
  }
  if (kind === 'item') {
    const str = (field: string) => (typeof raw[field] === 'string' ? raw[field].trim() : null)
    const unit = str('unit')
    if (!unit) add('unit', "L'unità di misura è obbligatoria.")
    else if (unit.length > 20) add('unit', 'Al massimo 20 caratteri.')
    const quantity = str('quantity')
    if (!quantity || !QUANTITY.test(quantity)) {
      add('quantity', 'Una quantità come 12.5, con il punto e al massimo tre decimali.')
    }
    const price = str('unit_price')
    const cents = price === null ? null : amountToCents(price)
    if (cents === null)
      add('unit_price', 'Un importo come 1234.50, con il punto e al massimo due decimali.')
    const discount = str('discount_percent')
    if (!discount || !PERCENT.test(discount)) {
      add('discount_percent', 'Una percentuale da 0 a 100, al massimo due decimali.')
    }
    const vat = VAT_RATES.find((r) => r === raw.vat_rate)
    if (vat === undefined) add('vat_rate', 'Aliquota IVA non valida: 22, 10, 5, 4 o 0.')
    const nature = raw.vat_nature ?? null
    if (nature !== null && !isVatNature(nature)) {
      add('vat_nature', 'Natura IVA non valida: un codice come N6.7.')
    } else if (nature !== null && vat !== undefined && vat !== 0) {
      add('vat_nature', "La natura IVA si indica solo con l'aliquota 0.")
    }
    Object.assign(input, {
      unit,
      quantity,
      unitPriceCents: cents,
      discount,
      vatRate: vat ?? null,
      vatNature: isVatNature(nature) ? nature : null,
    })
  } else if (kind) {
    for (const field of [
      'unit',
      'quantity',
      'unit_price',
      'discount_percent',
      'vat_rate',
      'vat_nature',
    ]) {
      if (raw[field] !== null && raw[field] !== undefined) {
        add(field, 'Solo le righe con prezzo hanno questo campo: invia null.')
      }
    }
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return input
}

function parseArrangement(body: unknown): string[] {
  const lines =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).lines
      : undefined
  if (!Array.isArray(lines)) {
    throw new ValidationFailed({ lines: ['Serve l’elenco degli id delle righe.'] })
  }
  if (lines.length > 2000) throw new ValidationFailed({ lines: ['Al massimo 2000 righe.'] })
  if (!lines.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    throw new ValidationFailed({ lines: ['Ogni elemento deve essere l’id di una riga.'] })
  }
  return lines.map((id) => id.toLowerCase())
}

/** Opens the company and the quote; writes need a draft, locked until commit. */
async function enterQuote(
  client: PoolClient,
  request: FastifyRequest<{ Params: Params }>,
  permission: 'quotes.view' | 'quotes.update',
) {
  const permissions = await enterCompany(client, request.params.company)
  if (!permissions.has(permission)) {
    if (permission === 'quotes.view') throw notFound()
    throw forbidden()
  }
  const id = request.params.quote
  if (!UUID.test(id)) throw notFound()
  const { rows } = await client.query<{ status: string }>(
    `select status from public.quotes where id = $1 ${permission === 'quotes.update' ? 'for update' : ''}`,
    [id],
  )
  if (!rows[0]) throw notFound()
  if (permission === 'quotes.update' && rows[0].status !== 'draft') {
    throw new ApiError(409, messages.quoteNotDraft, 'quote_not_draft')
  }
  return id
}

const touch = (client: PoolClient, quoteId: string) =>
  client.query('update public.quotes set updated_at = now() where id = $1', [quoteId])

async function readLine(client: PoolClient, id: string) {
  const { rows } = await client.query<LineRow>(
    `select ${LINE_COLUMNS} from public.quote_lines where id = $1`,
    [id],
  )
  return rows[0]
}

async function missingOrStale(client: PoolClient, quoteId: string, id: string): Promise<never> {
  const { rowCount } = await client.query(
    'select 1 from public.quote_lines where id = $1 and quote_id = $2',
    [id, quoteId],
  )
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.lineStale, 'stale_record')
}

const values = (input: LineInput) => [
  input.kind,
  input.description,
  input.unit,
  input.quantity,
  input.unitPriceCents,
  input.discount,
  input.vatRate,
  input.vatNature,
]

export function quoteLineRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/quotes/:quote/lines'

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const quoteId = await enterQuote(client, request, 'quotes.view')
      const { rows } = await client.query<LineRow>(
        `select ${LINE_COLUMNS} from public.quote_lines where quote_id = $1 order by position, id`,
        [quoteId],
      )
      return { data: rows.map(lineToContract) }
    })
  })

  app.get<{ Params: Params }>(`${base}/export`, async (request, reply) => {
    const session = requireSession(request)
    const { number, rows } = await withIdentity(
      db.app,
      { userId: session.user.id },
      async (client) => {
        const quoteId = await enterQuote(client, request, 'quotes.view')
        const quote = await client.query<{
          number_year: number | null
          number_seq: number | null
          revision: number | null
        }>('select number_year, number_seq, revision from public.quotes where id = $1', [quoteId])
        const lines = await client.query<LineRow>(
          `select ${LINE_COLUMNS} from public.quote_lines where quote_id = $1 order by position, id`,
          [quoteId],
        )
        const q = quote.rows[0]
        const number = q ? formatQuoteNumber(q.number_year, q.number_seq, q.revision) : null
        return { number, rows: lines.rows }
      },
    )
    const comma = (value: string | null) => (value === null ? null : value.replace('.', ','))
    const csv = toCsv(
      [
        'Tipo',
        'Descrizione',
        'Unità',
        'Quantità',
        'Prezzo',
        'Sconto %',
        'Imponibile',
        'IVA %',
        'Natura IVA',
      ],
      rows.map((r) => [
        KIND_LABELS[r.kind],
        r.description,
        r.unit,
        comma(r.quantity),
        r.unit_price_cents === null ? null : italianAmount(r.unit_price_cents),
        comma(r.discount_percent),
        r.amount_cents === null ? null : italianAmount(r.amount_cents),
        r.vat_rate,
        r.vat_nature,
      ]),
    )
    const name = number ? `preventivo-${number.replace('/', '-')}` : 'preventivo-bozza'
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}.csv"`)
      .send(csv)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const quoteId = await enterQuote(client, request, 'quotes.update')
      const input = parseLine(request.body)
      const { rows } = await client.query<{ id: string }>(
        `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
           unit_price_cents, discount_percent, vat_rate, vat_nature, position)
         values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
           (select coalesce(max(position) + 1, 0) from public.quote_lines where quote_id = $1))
         returning id`,
        [quoteId, ...values(input)],
      )
      await touch(client, quoteId)
      return readLine(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return sendLine(reply, row, 201)
  })

  app.put<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const quoteId = await enterQuote(client, request, 'quotes.update')
      const order = parseArrangement(request.body)
      const { rows: existing } = await client.query<{ id: string }>(
        'select id from public.quote_lines where quote_id = $1',
        [quoteId],
      )
      const known = new Set(existing.map((r) => r.id))
      if (
        new Set(order).size !== order.length ||
        order.length !== known.size ||
        !order.every((id) => known.has(id))
      ) {
        throw new ValidationFailed({
          lines: [
            'Servono tutte le righe del preventivo, ognuna una volta sola: ricarica la pagina.',
          ],
        })
      }
      await client.query(
        `update public.quote_lines l set position = o.n - 1
         from unnest($2::uuid[]) with ordinality as o(id, n)
         where l.id = o.id and l.quote_id = $1 and l.position <> o.n - 1`,
        [quoteId, order],
      )
      await touch(client, quoteId)
      const { rows } = await client.query<LineRow>(
        `select ${LINE_COLUMNS} from public.quote_lines where quote_id = $1 order by position, id`,
        [quoteId],
      )
      return { data: rows.map(lineToContract) }
    })
  })

  app.put<{ Params: Params }>(`${base}/:line`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const quoteId = await enterQuote(client, request, 'quotes.update')
      const id = request.params.line ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseLine(request.body)
      const { rowCount } = await client.query(
        `update public.quote_lines
         set kind = $1, description = $2, unit = $3, quantity = $4, unit_price_cents = $5,
             discount_percent = $6, vat_rate = $7, vat_nature = $8, version = version + 1,
             updated_at = now()
         where id = $9 and quote_id = $10 and version = $11`,
        [...values(input), id, quoteId, version],
      )
      if (!rowCount) return missingOrStale(client, quoteId, id)
      await touch(client, quoteId)
      return readLine(client, id)
    })
    if (!row) throw notFound()
    return sendLine(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:line`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const quoteId = await enterQuote(client, request, 'quotes.update')
      const id = request.params.line ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.quote_lines where id = $1 and quote_id = $2 and version = $3',
        [id, quoteId, version],
      )
      if (!rowCount) await missingOrStale(client, quoteId, id)
      await touch(client, quoteId)
    })
    return reply.code(204).send()
  })
}
