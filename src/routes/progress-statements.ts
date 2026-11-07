import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
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
import { statementPdf } from '../progress/pdf.js'
import { readLogoForPdf } from './logo.js'
import { readProfile } from './settings.js'
import { MAX_EXPORT_ROWS, italianAmount, italianDate, toCsv } from '../csv.js'

const MAX_LINES = 2000
/** numeric(14,3): at most 11 digits before the point. */
const QUANTITY = /^-?\d{1,11}(?:\.\d{1,3})?$/
const PERCENT = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/

type Params = { company: string; estimate: string; statement?: string }

interface StatementRow {
  id: string
  estimate_id: string
  number: number
  statement_date: string
  status: 'draft' | 'approved'
  notes: string | null
  retention_percent: string
  approved_at: Date | null
  invoice_id: string | null
  version: number
  created_at: Date
  updated_at: Date
  amount_cents: string
  retention_cents: string
  previous_cents: string
}

interface LineRow {
  item_id: string
  code: string | null
  description: string
  unit: string
  unit_price_cents: string
  contract_quantity: string
  quantity: string
  previous_quantity: string
  cumulative_quantity: string
  amount_cents: string
  previous_cents: string
  cumulative_cents: string
}

interface StatementInput {
  statement_date: string
  notes: string | null
  /** Null when absent: the previous statement's on creation, unchanged on update. */
  retentionPercent: string | null
  lines: { item_id: string; quantity: string }[]
}

/** Line amounts are rounded to the cent one by one; totals add the rounded amounts. */
const SELECT = `select s.id, s.estimate_id, s.number, s.statement_date::text as statement_date,
    s.status, s.notes, s.retention_percent::text as retention_percent, s.approved_at, s.version,
    s.created_at, s.updated_at,
    (select i.id from public.invoices i where i.progress_statement_id = s.id) as invoice_id,
    cur.cents::text as amount_cents,
    round(cur.cents * s.retention_percent / 100)::text as retention_cents,
    coalesce((select sum(round(l.quantity * l.unit_price_cents))
              from public.progress_statement_lines l
              join public.progress_statements p on p.id = l.statement_id
              where p.estimate_id = s.estimate_id and p.number < s.number), 0)::text
      as previous_cents
  from public.progress_statements s
  cross join lateral (
    select coalesce(sum(round(l.quantity * l.unit_price_cents)), 0) as cents
    from public.progress_statement_lines l where l.statement_id = s.id
  ) cur`

const LINES = `with cur as (
    select item_id, quantity, unit_price_cents, round(quantity * unit_price_cents) as cents
    from public.progress_statement_lines where statement_id = $1
  ), prev as (
    select l.item_id, sum(l.quantity) as quantity,
      sum(round(l.quantity * l.unit_price_cents)) as cents
    from public.progress_statement_lines l
    join public.progress_statements p on p.id = l.statement_id
    where p.estimate_id = $2 and p.number < $3
    group by l.item_id
  )
  select i.id as item_id, i.code, i.description, i.unit,
    coalesce(cur.unit_price_cents, 0)::text as unit_price_cents,
    t.quantity::numeric(20, 3)::text as contract_quantity,
    coalesce(cur.quantity, 0)::numeric(20, 3)::text as quantity,
    coalesce(prev.quantity, 0)::numeric(20, 3)::text as previous_quantity,
    (coalesce(cur.quantity, 0) + coalesce(prev.quantity, 0))::numeric(20, 3)::text
      as cumulative_quantity,
    coalesce(cur.cents, 0)::text as amount_cents,
    coalesce(prev.cents, 0)::text as previous_cents,
    (coalesce(cur.cents, 0) + coalesce(prev.cents, 0))::text as cumulative_cents
  from public.estimate_items i
  join public.estimate_item_totals t on t.item_id = i.id
  left join cur on cur.item_id = i.id
  left join prev on prev.item_id = i.id
  where i.estimate_id = $2 and (cur.item_id is not null or prev.item_id is not null)
  order by lower(i.code) nulls last, lower(i.description), i.id`

const cumulative = (row: StatementRow) =>
  (BigInt(row.amount_cents) + BigInt(row.previous_cents)).toString()

const summaryToContract = (row: StatementRow) => ({
  id: row.id,
  estimate_id: row.estimate_id,
  number: row.number,
  statement_date: row.statement_date,
  status: row.status,
  notes: row.notes,
  amount: centsToAmount(row.amount_cents),
  previous_amount: centsToAmount(row.previous_cents),
  cumulative_amount: centsToAmount(cumulative(row)),
  retention_percent: row.retention_percent,
  retention_amount: centsToAmount(row.retention_cents),
  net_amount: centsToAmount((BigInt(row.amount_cents) - BigInt(row.retention_cents)).toString()),
  approved_at: row.approved_at?.toISOString() ?? null,
  invoice_id: row.invoice_id,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
})

const lineToContract = (row: LineRow) => ({
  item_id: row.item_id,
  code: row.code,
  description: row.description,
  unit: row.unit,
  unit_price: centsToAmount(row.unit_price_cents),
  contract_quantity: row.contract_quantity,
  quantity: row.quantity,
  previous_quantity: row.previous_quantity,
  cumulative_quantity: row.cumulative_quantity,
  amount: centsToAmount(row.amount_cents),
  previous_amount: centsToAmount(row.previous_cents),
  cumulative_amount: centsToAmount(row.cumulative_cents),
})

interface CompanyStatementRow extends StatementRow {
  estimate_title: string
  site_id: string | null
  site_name: string | null
  site_code: string | null
}

/** Filters of listCompanyProgressStatements, on the columns of the `st` CTE and `e`. */
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
  const add = (sql: (p: string) => string, value: unknown) => {
    values.push(value)
    where.push(sql(`$${values.length}`))
  }
  const site = single('filter[site]')
  if (site !== undefined) {
    if (!UUID.test(site)) errors['filter[site]'] = ['Identificativo non valido.']
    else add((p) => `e.site_id = ${p}`, site)
  }
  const clientId = single('filter[client]')
  if (clientId !== undefined) {
    if (!UUID.test(clientId)) errors['filter[client]'] = ['Identificativo non valido.']
    else add((p) => `e.client_id = ${p}`, clientId)
  }
  const status = single('filter[status]')
  if (status !== undefined) {
    if (status !== 'draft' && status !== 'approved') {
      errors['filter[status]'] = ['Valori ammessi: draft, approved.']
    } else add((p) => `st.status = ${p}`, status)
  }
  const invoiced = single('filter[invoiced]')
  if (invoiced !== undefined) {
    if (invoiced === 'true') where.push('st.invoice_id is not null')
    else if (invoiced === 'false') where.push('st.invoice_id is null')
    else errors['filter[invoiced]'] = ['Valori ammessi: true, false.']
  }
  for (const [name, op] of [
    ['filter[from]', '>='],
    ['filter[to]', '<='],
  ] as const) {
    const value = single(name)
    if (value === undefined) continue
    if (!isIsoDate(value)) errors[name] = ['Data non valida (AAAA-MM-GG).']
    else add((p) => `st.statement_date::date ${op} ${p}::date`, value)
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, where, values }
}

/** The SAL of the whole company, with their estimate and site, filtered by `where`. */
const companyStatements = (where: string[], columns: string) => `with st as (${SELECT})
  select ${columns} from st join public.estimates e on e.id = st.estimate_id
  left join public.sites site on site.id = e.site_id
  where ${where.join(' and ')}`

async function readCompanyStatements(
  client: PoolClient,
  list: ReturnType<typeof readCompanyList>,
  limit: number,
  offset: number,
) {
  const n = list.values.length
  const { rows } = await client.query<CompanyStatementRow>(
    `${companyStatements(
      list.where,
      `st.*, e.title as estimate_title, site.id as site_id, site.name as site_name,
       site.code as site_code`,
    )}
     order by st.statement_date desc, st.number desc, st.id
     limit $${n + 1} offset $${n + 2}`,
    [...list.values, limit, offset],
  )
  return rows
}

/** Drafts, and approved SAL without an invoice with their amounts, for the dashboard. */
export async function statementTotals(client: PoolClient) {
  const { rows } = await client.query<{
    drafts: number
    to_invoice: number
    amount: string
    net: string
  }>(
    companyStatements(
      ['true'],
      `count(*) filter (where st.status = 'draft')::int as drafts,
       count(*) filter (where st.status = 'approved' and st.invoice_id is null)::int as to_invoice,
       coalesce(sum(st.amount_cents::bigint)
         filter (where st.status = 'approved' and st.invoice_id is null), 0)::text as amount,
       coalesce(sum(st.amount_cents::bigint - st.retention_cents::bigint)
         filter (where st.status = 'approved' and st.invoice_id is null), 0)::text as net`,
    ),
  )
  const r = rows[0]
  return {
    drafts: r?.drafts ?? 0,
    to_invoice: r?.to_invoice ?? 0,
    to_invoice_amount: centsToAmount(r?.amount ?? '0'),
    to_invoice_net_amount: centsToAmount(r?.net ?? '0'),
  }
}

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.statementMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

function parseStatement(body: unknown): StatementInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const errors: FieldErrors = {}
  let statement_date = ''
  if (!('statement_date' in raw)) errors.statement_date = ['Campo mancante.']
  else if (typeof raw.statement_date !== 'string' || !isIsoDate(raw.statement_date)) {
    errors.statement_date = ['Data non valida (AAAA-MM-GG).']
  } else statement_date = raw.statement_date
  let notes: string | null = null
  if (!('notes' in raw)) errors.notes = ['Campo mancante.']
  else if (raw.notes !== null && typeof raw.notes !== 'string')
    errors.notes = ['Deve essere un testo.']
  else {
    const trimmed = (raw.notes ?? '').trim()
    if (trimmed.length > 2000) errors.notes = ['Al massimo 2000 caratteri.']
    notes = trimmed === '' ? null : trimmed
  }
  let retentionPercent: string | null = null
  if (raw.retention_percent !== undefined && raw.retention_percent !== null) {
    if (typeof raw.retention_percent !== 'string' || !PERCENT.test(raw.retention_percent)) {
      errors.retention_percent = ['Una percentuale da 0 a 100, al massimo due decimali.']
    } else retentionPercent = raw.retention_percent
  }
  const lines: StatementInput['lines'] = []
  if (!Array.isArray(raw.lines)) errors.lines = ['Serve un elenco di righe.']
  else if (raw.lines.length > MAX_LINES) errors.lines = [`Al massimo ${MAX_LINES} righe.`]
  else {
    const seen = new Set<string>()
    raw.lines.forEach((line: unknown, index) => {
      const l = typeof line === 'object' && line !== null ? (line as Record<string, unknown>) : {}
      const itemId = typeof l.item_id === 'string' ? l.item_id.toLowerCase() : ''
      if (!UUID.test(itemId)) errors[`lines.${index}.item_id`] = ['Voce non trovata.']
      else if (seen.has(itemId)) errors[`lines.${index}.item_id`] = ['Voce ripetuta.']
      seen.add(itemId)
      if (typeof l.quantity !== 'string' || !QUANTITY.test(l.quantity)) {
        errors[`lines.${index}.quantity`] = ['Quantità non valida (es. 12.5).']
      }
      lines.push({ item_id: itemId, quantity: typeof l.quantity === 'string' ? l.quantity : '0' })
    })
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { statement_date, notes, retentionPercent, lines }
}

async function readStatement(client: PoolClient, estimateId: string, id: string | undefined) {
  if (!id || !UUID.test(id)) return undefined
  const { rows } = await client.query<StatementRow>(
    `${SELECT} where s.id = $1 and s.estimate_id = $2`,
    [id, estimateId],
  )
  return rows[0]
}

async function fullStatement(client: PoolClient, row: StatementRow) {
  const { rows } = await client.query<LineRow>(LINES, [row.id, row.estimate_id, row.number])
  return { ...summaryToContract(row), lines: rows.map(lineToContract) }
}

/** Replaces the lines, copying the current unit price of each item. */
async function writeLines(
  client: PoolClient,
  estimateId: string,
  statementId: string,
  lines: StatementInput['lines'],
) {
  await client.query('delete from public.progress_statement_lines where statement_id = $1', [
    statementId,
  ])
  if (lines.length === 0) return
  const { rowCount } = await client.query(
    `insert into public.progress_statement_lines (company_id, estimate_id, statement_id, item_id,
       quantity, unit_price_cents)
     select app.current_company_id(), $1, $2, i.id, l.quantity, i.unit_price_cents
     from unnest($3::uuid[], $4::numeric[]) as l (item_id, quantity)
     join public.estimate_items i on i.id = l.item_id and i.estimate_id = $1`,
    [estimateId, statementId, lines.map((l) => l.item_id), lines.map((l) => l.quantity)],
  )
  if (rowCount !== lines.length) {
    throw new ValidationFailed({ lines: ['Una o più voci non sono di questo computo.'] })
  }
}

const notDraft = () => new ApiError(409, messages.statementNotDraft, 'statement_not_draft')

const send = async (
  reply: FastifyReply,
  result: { version: number; body: unknown },
  status = 200,
) => reply.code(status).header('ETag', `"${result.version}"`).send(result.body)

export function progressStatementRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/estimates/:estimate/progress-statements'

  /**
   * estimates.view to see the estimate (404 otherwise), then the permission of the action.
   * Writers lock the estimate row, so numbers and the single draft are assigned one at a time.
   */
  const inEstimate = <T>(
    request: { params: Params },
    userId: string,
    permission: 'estimates.view' | 'estimates.update' | 'estimates.approve',
    fn: (client: PoolClient, estimateId: string) => Promise<T>,
  ) =>
    withIdentity(db.app, { userId }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('estimates.view')) throw notFound()
      if (!permissions.has(permission)) throw forbidden()
      const id = request.params.estimate
      if (!UUID.test(id)) throw notFound()
      const lock = permission === 'estimates.view' ? '' : ' for update'
      const { rowCount } = await client.query(
        `select 1 from public.estimates where id = $1${lock}`,
        [id],
      )
      if (!rowCount) throw notFound()
      return fn(client, id)
    })

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/progress-statements/export',
    async (request, reply) => {
      const session = requireSession(request)
      const list = readCompanyList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('estimates.view')) throw forbidden()
        const rows = await readCompanyStatements(client, list, MAX_EXPORT_ROWS, 0)
        return toCsv(
          [
            'Data',
            'Cantiere',
            'Computo',
            'SAL n.',
            'Stato',
            'Importo',
            'Ritenuta %',
            'Ritenuta',
            'Netto',
            'Fatturato',
          ],
          rows.map((r) => [
            italianDate(r.statement_date),
            r.site_name,
            r.estimate_title,
            r.number,
            r.status === 'approved' ? 'Approvato' : 'Bozza',
            italianAmount(r.amount_cents),
            r.retention_percent.replace('.', ','),
            italianAmount(r.retention_cents),
            italianAmount((BigInt(r.amount_cents) - BigInt(r.retention_cents)).toString()),
            r.invoice_id ? 'Sì' : 'No',
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="sal.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/progress-statements',
    async (request) => {
      const session = requireSession(request)
      const list = readCompanyList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('estimates.view')) throw forbidden()
        const rows = await readCompanyStatements(
          client,
          list,
          list.perPage,
          (list.page - 1) * list.perPage,
        )
        const count = await client.query<{ total: number; amount: string; net: string }>(
          companyStatements(
            list.where,
            `count(*)::int as total,
             coalesce(sum(st.amount_cents::bigint), 0)::text as amount,
             coalesce(sum(st.amount_cents::bigint - st.retention_cents::bigint), 0)::text as net`,
          ),
          list.values,
        )
        const totals = count.rows[0]
        return {
          data: rows.map((r) => ({
            ...summaryToContract(r),
            estimate: { id: r.estimate_id, title: r.estimate_title },
            site: r.site_id ? { id: r.site_id, name: r.site_name ?? '', code: r.site_code } : null,
          })),
          meta: { total: totals?.total ?? 0, page: list.page, per_page: list.perPage },
          total_amount: centsToAmount(totals?.amount ?? '0'),
          total_net_amount: centsToAmount(totals?.net ?? '0'),
        }
      })
    },
  )

  app.get<{ Params: Params }>(base, async (request) => {
    const session = requireSession(request)
    return inEstimate(request, session.user.id, 'estimates.view', async (client, estimateId) => {
      const { rows } = await client.query<StatementRow>(
        `${SELECT} where s.estimate_id = $1 order by s.number`,
        [estimateId],
      )
      return { data: rows.map(summaryToContract) }
    })
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const result = await inEstimate(
      request,
      session.user.id,
      'estimates.update',
      async (client, estimateId) => {
        const input = parseStatement(request.body)
        const draft = await client.query(
          "select 1 from public.progress_statements where estimate_id = $1 and status = 'draft'",
          [estimateId],
        )
        if (draft.rowCount) {
          throw new ApiError(409, messages.statementDraftExists, 'statement_draft_exists')
        }
        const { rows } = await client.query<{ id: string }>(
          `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
             notes, retention_percent)
           select app.current_company_id(), $1, coalesce(max(number), 0) + 1, $2, $3,
             coalesce($4::numeric, (select p.retention_percent from public.progress_statements p
                                    where p.estimate_id = $1 order by p.number desc limit 1), 0)
           from public.progress_statements where estimate_id = $1
           returning id`,
          [estimateId, input.statement_date, input.notes, input.retentionPercent],
        )
        const id = rows[0]?.id
        if (!id) throw new Error('insert returned no row')
        await writeLines(client, estimateId, id, input.lines)
        const row = await readStatement(client, estimateId, id)
        if (!row) throw new Error('insert returned no row')
        return { version: row.version, body: await fullStatement(client, row) }
      },
    )
    return send(reply, result, 201)
  })

  app.get<{ Params: Params }>(`${base}/:statement`, async (request, reply) => {
    const session = requireSession(request)
    const result = await inEstimate(
      request,
      session.user.id,
      'estimates.view',
      async (client, estimateId) => {
        const row = await readStatement(client, estimateId, request.params.statement)
        if (!row) throw notFound()
        return { version: row.version, body: await fullStatement(client, row) }
      },
    )
    return send(reply, result)
  })

  app.get<{ Params: Params }>(`${base}/:statement/pdf`, async (request, reply) => {
    const session = requireSession(request)
    const pdf = await inEstimate(
      request,
      session.user.id,
      'estimates.view',
      async (client, estimateId) => {
        const row = await readStatement(client, estimateId, request.params.statement)
        if (!row) throw notFound()
        const statement = await fullStatement(client, row)
        const { rows } = await client.query<{
          title: string
          client: string | null
          site: string | null
          address: string | null
        }>(
          `select e.title, c.name as client, s.name as site, e.site_address as address
           from public.estimates e
           left join public.clients c on c.id = e.client_id
           left join public.sites s on s.id = e.site_id
           where e.id = $1`,
          [estimateId],
        )
        const estimate = rows[0]
        if (!estimate) throw notFound()
        const profile = await readProfile(client)
        return {
          number: row.number,
          buffer: statementPdf({
            logo: await readLogoForPdf(client),
            company: {
              ...profile,
              share_capital:
                profile.share_capital_cents === null
                  ? null
                  : centsToAmount(profile.share_capital_cents),
            },
            estimate,
            ...statement,
          }),
        }
      },
    )
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="sal-${pdf.number}.pdf"`)
      .header('Cache-Control', 'private, no-store')
      .send(pdf.buffer)
  })

  app.put<{ Params: Params }>(`${base}/:statement`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const result = await inEstimate(
      request,
      session.user.id,
      'estimates.update',
      async (client, estimateId) => {
        const current = await readStatement(client, estimateId, request.params.statement)
        if (!current) throw notFound()
        const version = expectedVersion(request.headers['if-match'])
        if (current.version !== version) {
          throw new ApiError(412, messages.statementStale, 'stale_record')
        }
        if (current.status !== 'draft') throw notDraft()
        const input = parseStatement(request.body)
        await client.query(
          `update public.progress_statements set statement_date = $1, notes = $2,
             retention_percent = coalesce($4::numeric, retention_percent),
             version = version + 1, updated_at = now()
           where id = $3`,
          [input.statement_date, input.notes, current.id, input.retentionPercent],
        )
        await writeLines(client, estimateId, current.id, input.lines)
        const row = await readStatement(client, estimateId, current.id)
        if (!row) throw notFound()
        return { version: row.version, body: await fullStatement(client, row) }
      },
    )
    return send(reply, result)
  })

  app.delete<{ Params: Params }>(`${base}/:statement`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await inEstimate(request, session.user.id, 'estimates.update', async (client, estimateId) => {
      const current = await readStatement(client, estimateId, request.params.statement)
      if (!current) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      if (current.version !== version) {
        throw new ApiError(412, messages.statementStale, 'stale_record')
      }
      if (current.status !== 'draft') throw notDraft()
      await client.query('delete from public.progress_statements where id = $1', [current.id])
    })
    return reply.code(204).send()
  })

  app.post<{ Params: Params }>(`${base}/:statement/approve`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const result = await inEstimate(
      request,
      session.user.id,
      'estimates.approve',
      async (client, estimateId) => {
        const current = await readStatement(client, estimateId, request.params.statement)
        if (!current) throw notFound()
        const version = expectedVersion(request.headers['if-match'])
        if (current.version !== version) {
          throw new ApiError(412, messages.statementStale, 'stale_record')
        }
        if (current.status !== 'draft') throw notDraft()
        await client.query(
          `update public.progress_statements set status = 'approved', approved_at = now(),
             version = version + 1, updated_at = now()
           where id = $1`,
          [current.id],
        )
        const row = await readStatement(client, estimateId, current.id)
        if (!row) throw notFound()
        return { version: row.version, body: await fullStatement(client, row) }
      },
    )
    return send(reply, result)
  })
}
