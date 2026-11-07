import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { italianDate, MAX_EXPORT_ROWS, toCsv } from '../csv.js'
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
import { quotePdf } from '../quotes/pdf.js'
import { readLogoForPdf } from './logo.js'
import { readProfile } from './settings.js'
import { VAT_RATES, isVatNature, type VatNature } from '../quotes/vat.js'
import { LINE_COLUMNS, lineToContract, type LineRow } from './quote-lines.js'

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const
type Status = (typeof STATUSES)[number]

interface QuoteInput {
  client_id: string
  subject: string
  validity_days: number
  notes: string | null
  terms: string | null
}
const FIELDS = ['client_id', 'subject', 'validity_days', 'notes', 'terms'] as const

interface QuoteRow extends QuoteInput {
  id: string
  client_name: string
  status: Status
  number_year: number | null
  number_seq: number | null
  revision: number | null
  revision_of_id: string | null
  revision_of_year: number | null
  revision_of_seq: number | null
  revision_of_revision: number | null
  issue_date: string | null
  valid_until: string | null
  sent_at: Date | null
  vat_breakdown: { rate: number; nature: VatNature | null; taxable: string; vat: string }[]
  version: number
  created_at: Date
  updated_at: Date
}

type Params = { company: string; quote?: string }

const SELECT = `select q.id, q.client_id, q.subject, q.validity_days, q.notes, q.terms, q.status,
    q.number_year, q.number_seq, q.revision, q.revision_of_id,
    src.number_year as revision_of_year, src.number_seq as revision_of_seq,
    src.revision as revision_of_revision, q.issue_date::text as issue_date,
    (q.issue_date + q.validity_days)::text as valid_until, q.sent_at, q.version,
    q.created_at, q.updated_at, c.name as client_name,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'rate', r.vat_rate, 'nature', r.vat_nature, 'taxable', r.taxable::text,
        'vat', r.vat::text)
        order by r.vat_rate desc, r.vat_nature asc nulls first), '[]'::jsonb)
     from (
       select vat_rate, vat_nature, sum(amount) as taxable,
         round(sum(amount) * vat_rate / 100) as vat
       from (
         select l.vat_rate, l.vat_nature,
           round(l.quantity * l.unit_price_cents * (100 - l.discount_percent) / 100) as amount
         from public.quote_lines l where l.quote_id = q.id and l.kind = 'item'
       ) lines group by vat_rate, vat_nature
     ) r) as vat_breakdown
  from public.quotes q
  join public.clients c on c.id = q.client_id
  left join public.quotes src on src.id = q.revision_of_id`

const SORTS = {
  number: 'q.number_year asc nulls last, q.number_seq asc nulls last, q.id asc',
  '-number': 'q.number_year desc nulls last, q.number_seq desc nulls last, q.id desc',
  issue_date: 'q.issue_date asc nulls last, q.id asc',
  '-issue_date': 'q.issue_date desc nulls last, q.id desc',
  updated_at: 'q.updated_at asc, q.id asc',
  '-updated_at': 'q.updated_at desc, q.id desc',
} as const

function formatNumber(year: number | null, seq: number | null, revision: number | null) {
  if (year === null || seq === null) return null
  const base = `${year}/${String(seq).padStart(3, '0')}`
  return revision ? `${base}-R${revision}` : base
}

/** Totals in integer cents (BigInt), from the per-rate sums computed by the database. */
function totals(breakdown: QuoteRow['vat_breakdown']) {
  const taxable = breakdown.reduce((sum, r) => sum + BigInt(r.taxable), 0n)
  const vat = breakdown.reduce((sum, r) => sum + BigInt(r.vat), 0n)
  return {
    taxable: centsToAmount(taxable.toString()),
    vat: breakdown.map((r) => ({
      rate: r.rate,
      nature: r.nature,
      taxable: centsToAmount(r.taxable),
      vat: centsToAmount(r.vat),
    })),
    vat_total: centsToAmount(vat.toString()),
    total: centsToAmount((taxable + vat).toString()),
  }
}

function toContract(row: QuoteRow) {
  return {
    id: row.id,
    client_id: row.client_id,
    client: { id: row.client_id, name: row.client_name },
    subject: row.subject,
    validity_days: row.validity_days,
    notes: row.notes,
    terms: row.terms,
    status: row.status,
    number: formatNumber(row.number_year, row.number_seq, row.revision),
    revision: row.revision,
    revision_of: row.revision_of_id
      ? {
          id: row.revision_of_id,
          number: formatNumber(row.revision_of_year, row.revision_of_seq, row.revision_of_revision),
        }
      : null,
    issue_date: row.issue_date,
    valid_until: row.valid_until,
    sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    totals: totals(row.vat_breakdown),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

const send = (reply: FastifyReply, row: QuoteRow, status = 200) =>
  reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.quoteMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseInput(body: unknown): QuoteInput {
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
  const client_id = text('client_id', 36)
  if (client_id === null && !errors.client_id) add('client_id', 'Il cliente è obbligatorio.')
  else if (client_id !== null && !UUID.test(client_id) && !errors.client_id) {
    add('client_id', 'Cliente non trovato.')
  }
  const subject = text('subject', 200)
  if (subject === null && !errors.subject) add('subject', "L'oggetto è obbligatorio.")
  const days = raw.validity_days
  if (!('validity_days' in raw)) add('validity_days', 'Campo mancante.')
  else if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    add('validity_days', 'Un numero intero di giorni da 1 a 365.')
  }
  const notes = text('notes', 5000)
  const terms = text('terms', 10000)
  if (Object.keys(errors).length > 0 || !client_id || !subject) throw new ValidationFailed(errors)
  return { client_id, subject, validity_days: days as number, notes, terms }
}

function clientNotFound(error: unknown): never {
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
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? '-updated_at', search, status, clientId }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = ['true']
  const values: unknown[] = []
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  if (list.status) add((p) => `q.status = ${p}`, list.status)
  if (list.clientId) add((p) => `q.client_id = ${p}`, list.clientId)
  if (list.search) {
    add(
      (p) =>
        `(q.subject ilike ${p} or c.name ilike ${p}
          or (q.number_year::text || '/' || lpad(q.number_seq::text, 3, '0')) ilike ${p})`,
      `%${escapeLike(list.search)}%`,
    )
  }
  return { where, values }
}

const STATUS_LABELS: Record<Status, string> = {
  draft: 'Bozza',
  sent: 'Inviato',
  accepted: 'Accettato',
  rejected: 'Rifiutato',
  expired: 'Scaduto',
}

async function readOne(client: PoolClient, id: string) {
  const { rows } = await client.query<QuoteRow>(`${SELECT} where q.id = $1`, [id])
  return rows[0]
}

/** After a write that matched no row: 404, 409 if no longer a draft, else 412. */
async function whyNot(client: PoolClient, id: string, version: number): Promise<never> {
  const row = await readOne(client, id)
  if (!row) throw notFound()
  if (row.version !== version) throw new ApiError(412, messages.quoteStale, 'stale_record')
  throw new ApiError(409, messages.quoteNotDraft, 'quote_not_draft')
}

export function quoteRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/quotes'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.view')) throw forbidden()
      const { where, values } = listFilter(list)
      const filters = values.length
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<QuoteRow>(
        `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
         limit $${filters + 1} offset $${filters + 2}`,
        values,
      )
      const count = await client.query<{ total: number }>(
        `select count(*)::int as total from public.quotes q
         join public.clients c on c.id = q.client_id where ${where.join(' and ')}`,
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
        if (!permissions.has('quotes.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<QuoteRow>(
          `${SELECT} where ${where.join(' and ')} order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Numero',
            'Data',
            'Cliente',
            'Oggetto',
            'Stato',
            'Valido fino al',
            'Imponibile',
            'IVA',
            'Totale',
          ],
          rows.map((r) => {
            const t = totals(r.vat_breakdown)
            const comma = (amount: string) => amount.replace('.', ',')
            return [
              formatNumber(r.number_year, r.number_seq, r.revision),
              r.issue_date ? italianDate(r.issue_date) : null,
              r.client_name,
              r.subject,
              STATUS_LABELS[r.status],
              r.valid_until ? italianDate(r.valid_until) : null,
              comma(t.taxable),
              comma(t.vat_total),
              comma(t.total),
            ]
          }),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="preventivi.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:quote`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.view')) throw notFound()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.get<{ Params: Params }>(`${base}/:quote/pdf`, async (request, reply) => {
    const session = requireSession(request)
    const pdf = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.view')) throw notFound()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const row = await readOne(client, id)
      if (!row) throw notFound()
      const quote = toContract(row)
      const { rows: lines } = await client.query<LineRow>(
        `select ${LINE_COLUMNS} from public.quote_lines where quote_id = $1
         order by position, id`,
        [id],
      )
      const { rows: parties } = await client.query<{
        name: string
        vat_number: string | null
        tax_code: string | null
        street: string | null
        postal_code: string | null
        city: string | null
        province: string | null
      }>(
        `select c.name, c.vat_number, c.tax_code, c.street, c.postal_code, c.city, c.province
         from public.clients c where c.id = $1`,
        [row.client_id],
      )
      const party = parties[0]
      if (!party) throw notFound()
      const profile = await readProfile(client)
      const logo = await readLogoForPdf(client)
      return {
        number: quote.number,
        buffer: quotePdf({
          logo,
          company: {
            ...profile,
            share_capital:
              profile.share_capital_cents === null
                ? null
                : centsToAmount(profile.share_capital_cents),
          },
          client: party,
          number: quote.number,
          issue_date: quote.issue_date,
          valid_until: quote.valid_until,
          validity_days: quote.validity_days,
          subject: quote.subject,
          notes: quote.notes,
          terms: quote.terms,
          lines: lines.map(lineToContract),
          totals: quote.totals,
        }),
      }
    })
    const name = pdf.number ? `preventivo-${pdf.number.replace('/', '-')}` : 'preventivo-bozza'
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${name}.pdf"`)
      .header('Cache-Control', 'private, no-store')
      .send(pdf.buffer)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.create')) throw forbidden()
      const input = parseInput(request.body)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.quotes (company_id, ${FIELDS.join(', ')})
           values (app.current_company_id(), ${FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
           returning id`,
          FIELDS.map((f) => input[f]),
        )
        .catch(clientNotFound)
      return readOne(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:quote`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.update')) throw forbidden()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseInput(request.body)
      const values: unknown[] = FIELDS.map((f) => input[f])
      values.push(id, version)
      const { rowCount } = await client
        .query(
          `update public.quotes
           set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}
             and status = 'draft'`,
          values,
        )
        .catch(clientNotFound)
      if (!rowCount) return whyNot(client, id, version)
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/:quote`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.delete')) throw forbidden()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        "delete from public.quotes where id = $1 and version = $2 and status = 'draft'",
        [id, version],
      )
      if (!rowCount) await whyNot(client, id, version)
    })
    return reply.code(204).send()
  })

  app.post<{ Params: Params }>(`${base}/:quote/send`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.update')) throw forbidden()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rows } = await client.query<{ id: string; revision_of_id: string | null }>(
        `select id, revision_of_id from public.quotes
         where id = $1 and version = $2 and status = 'draft' for update`,
        [id, version],
      )
      if (!rows[0]) return whyNot(client, id, version)
      if (rows[0].revision_of_id) {
        await sendRevision(client, id, rows[0].revision_of_id)
        return readOne(client, id)
      }
      // The counter row is locked until commit: two sends never get the same number, and a
      // rolled back send gives its number back, so there are no gaps.
      const { rows: counter } = await client.query<{ year: number; last_number: number }>(
        `insert into public.quote_counters (company_id, year, last_number)
         values (app.current_company_id(),
           extract(year from (now() at time zone 'Europe/Rome'))::int, 1)
         on conflict (company_id, year)
           do update set last_number = public.quote_counters.last_number + 1
         returning year, last_number`,
      )
      const next = counter[0]
      if (!next) throw new Error('counter returned no row')
      await client.query(
        `update public.quotes
         set status = 'sent', number_year = $2, number_seq = $3, revision = 0,
             issue_date = (now() at time zone 'Europe/Rome')::date, sent_at = now(),
             version = version + 1, updated_at = now()
         where id = $1`,
        [id, next.year, next.last_number],
      )
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.post<{ Params: Params }>(`${base}/:quote/status`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.update')) throw forbidden()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const body = request.body as Record<string, unknown> | null
      const target = OUTCOMES.find((s) => s === body?.status)
      if (!target) throw new ValidationFailed({ status: ['Stato non valido.'] })
      // From sent to an outcome, or from an outcome back to sent.
      const from = target === 'sent' ? ['accepted', 'rejected', 'expired'] : ['sent']
      const { rowCount } = await client.query(
        `update public.quotes set status = $1, version = version + 1, updated_at = now()
         where id = $2 and version = $3 and status = any($4::text[])`,
        [target, id, version, from],
      )
      if (!rowCount) {
        const current = await readOne(client, id)
        if (!current) throw notFound()
        if (current.version !== version) {
          throw new ApiError(412, messages.quoteStale, 'stale_record')
        }
        throw new ApiError(409, messages.quoteInvalidTransition, 'invalid_transition')
      }
      return readOne(client, id)
    })
    if (!row) throw notFound()
    return send(reply, row)
  })

  app.post<{ Params: Params }>(`${base}/:quote/revisions`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('quotes.view')) throw notFound()
      if (!permissions.has('quotes.create')) throw forbidden()
      const id = request.params.quote ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows: source } = await client.query<{ status: Status }>(
        'select status from public.quotes where id = $1',
        [id],
      )
      if (!source[0]) throw notFound()
      if (!['sent', 'rejected', 'expired'].includes(source[0].status)) {
        throw new ApiError(409, messages.quoteNotRevisable, 'invalid_transition')
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into public.quotes (company_id, ${FIELDS.join(', ')}, revision_of_id)
         select company_id, ${FIELDS.join(', ')}, id from public.quotes where id = $1
         returning id`,
        [id],
      )
      const revisionId = rows[0]?.id ?? ''
      await client.query(
        `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
           unit_price_cents, discount_percent, vat_rate, vat_nature, position)
         select company_id, $2, kind, description, unit, quantity, unit_price_cents,
           discount_percent, vat_rate, vat_nature, position
         from public.quote_lines where quote_id = $1`,
        [id, revisionId],
      )
      return readOne(client, revisionId)
    })
    if (!row) throw new Error('insert returned no row')
    return send(reply, row, 201)
  })

  app.post<{ Params: Params & { estimate: string } }>(
    '/api/companies/:company/estimates/:estimate/quote',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('estimates.view')) throw notFound()
        if (!permissions.has('quotes.create')) throw forbidden()
        const estimateId = request.params.estimate
        if (!UUID.test(estimateId)) throw notFound()
        const found = await client.query('select 1 from public.estimates where id = $1', [
          estimateId,
        ])
        if (!found.rowCount) throw notFound()
        const input = parseInput(request.body)
        const body = request.body as Record<string, unknown>
        const rate = VAT_RATES.find((r) => r === body.vat_rate)
        if (rate === undefined) {
          throw new ValidationFailed({ vat_rate: ['Aliquota IVA non valida: 22, 10, 5, 4 o 0.'] })
        }
        const nature = body.vat_nature ?? null
        if (nature !== null && !isVatNature(nature)) {
          throw new ValidationFailed({
            vat_nature: ['Natura IVA non valida: un codice come N6.7.'],
          })
        }
        if (nature !== null && rate !== 0) {
          throw new ValidationFailed({
            vat_nature: ["La natura IVA si indica solo con l'aliquota 0."],
          })
        }
        const { rows } = await client
          .query<{ id: string }>(
            `insert into public.quotes (company_id, ${FIELDS.join(', ')})
             values (app.current_company_id(), ${FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
             returning id`,
            FIELDS.map((f) => input[f]),
          )
          .catch(clientNotFound)
        const quoteId = rows[0]?.id ?? ''
        await linesFromEstimate(client, estimateId, quoteId, rate, nature)
        return readOne(client, quoteId)
      })
      if (!row) throw new Error('insert returned no row')
      return send(reply, row, 201)
    },
  )
}

/**
 * A revision takes the number of the quote it comes from and the next revision of that
 * number. The counter row of that year is locked until commit, as for a first send, so
 * two revisions of the same number sent together never get the same revision.
 */
async function sendRevision(client: PoolClient, id: string, sourceId: string) {
  const { rows: source } = await client.query<{ number_year: number; number_seq: number }>(
    'select number_year, number_seq from public.quotes where id = $1',
    [sourceId],
  )
  const number = source[0]
  if (!number) throw new Error('revision without a numbered source')
  await client.query(
    `select 1 from public.quote_counters
     where company_id = app.current_company_id() and year = $1 for update`,
    [number.number_year],
  )
  await client.query(
    `update public.quotes
     set status = 'sent', number_year = $2, number_seq = $3,
         revision = (select coalesce(max(revision), 0) + 1 from public.quotes
                     where number_year = $2 and number_seq = $3),
         issue_date = (now() at time zone 'Europe/Rome')::date, sent_at = now(),
         version = version + 1, updated_at = now()
     where id = $1`,
    [id, number.number_year, number.number_seq],
  )
}
const OUTCOMES = ['sent', 'accepted', 'rejected', 'expired'] as const

/**
 * Chapters become sections and items become priced lines, depth first: a chapter, its
 * items, then its sub-chapters (a path sorts before the paths that extend it).
 */
async function linesFromEstimate(
  client: PoolClient,
  estimateId: string,
  quoteId: string,
  vatRate: number,
  vatNature: VatNature | null,
) {
  await client.query(
    `with recursive tree as (
       select id, array[position] as path from public.estimate_chapters
       where estimate_id = $1 and parent_id is null
       union all
       select c.id, t.path || c.position from public.estimate_chapters c
       join tree t on c.parent_id = t.id
     ), lines as (
       select t.path, 0 as kind_order, 0 as pos, c.id, 'section' as kind,
         concat_ws(' ', c.code, c.title) as description, null::text as unit,
         null::numeric as quantity, null::bigint as cents
       from tree t join public.estimate_chapters c on c.id = t.id
       union all
       select t.path, 1, i.position, i.id, 'item', concat_ws(' ', i.code, i.description),
         i.unit, round(tt.quantity, 3), i.unit_price_cents
       from tree t
       join public.estimate_items i on i.chapter_id = t.id
       join public.estimate_item_totals tt on tt.item_id = i.id
     )
     insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
       unit_price_cents, discount_percent, vat_rate, vat_nature, position)
     select app.current_company_id(), $2, kind, left(description, 5000), unit, quantity, cents,
       case when kind = 'item' then 0 end, case when kind = 'item' then $3::smallint end,
       case when kind = 'item' then $4::text end,
       (row_number() over (order by path, kind_order, pos, id) - 1)::int
     from lines`,
    [estimateId, quoteId, vatRate, vatNature],
  )
}
