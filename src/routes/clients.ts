import { MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import type { PoolClient } from 'pg'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import {
  CLIENT_FIELDS,
  CLIENT_KINDS,
  parseClientInput,
  type ClientInput,
} from '../clients/input.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { csvScope } from '../http/files.js'
import { ImportFailed } from '../csv-import.js'
import { RowErrors, parseClientsCsv, rowMessages } from '../clients/import.js'

interface ClientRow extends ClientInput {
  id: string
  archived_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, ${CLIENT_FIELDS.join(', ')}, archived_at, version, created_at, updated_at`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SORTS = {
  name: 'lower(name) asc, id asc',
  '-name': 'lower(name) desc, id desc',
  created_at: 'created_at asc, id asc',
  '-created_at': 'created_at desc, id desc',
} as const

type Params = { company: string; client?: string }

function toContract(row: ClientRow) {
  const client: Record<string, unknown> = { id: row.id }
  for (const field of CLIENT_FIELDS) client[field] = row[field]
  client.archived_at = row.archived_at?.toISOString() ?? null
  client.created_at = row.created_at.toISOString()
  client.updated_at = row.updated_at.toISOString()
  return client
}

const etagOf = (row: ClientRow) => `"${row.version}"`

/** Reads If-Match: the version the user was editing, or null if it cannot be one of ours. */
function expectedVersion(header: string): number | null {
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : null
}

function duplicateErrors(error: { constraint?: string | undefined }): FieldErrors | null {
  if (error.constraint === 'clients_vat_number_key') {
    return { vat_number: ['Esiste già un cliente con questa partita IVA.'] }
  }
  if (error.constraint === 'clients_tax_code_key') {
    return { tax_code: ['Esiste già un cliente con questo codice fiscale.'] }
  }
  return null
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
  const sortValue = single('sort') ?? 'name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const kindValue = single('filter[kind]')
  const kind = kindValue === undefined ? undefined : CLIENT_KINDS.find((k) => k === kindValue)
  if (kindValue !== undefined && !kind) errors['filter[kind]'] = ['Tipo di cliente non valido.']
  const archivedValue = single('filter[archived]') ?? 'false'
  if (archivedValue !== 'true' && archivedValue !== 'false') {
    errors['filter[archived]'] = ['Vale true oppure false.']
  }

  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { page, perPage, sort: sort ?? 'name', search, kind, archived: archivedValue === 'true' }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: { archived: boolean; kind?: string | undefined; search: string }) {
  const where = [list.archived ? 'archived_at is not null' : 'archived_at is null']
  const values: unknown[] = []
  if (list.kind) {
    values.push(list.kind)
    where.push(`kind = $${values.length}`)
  }
  if (list.search) {
    values.push(`%${escapeLike(list.search)}%`)
    const p = `$${values.length}`
    where.push(
      `(name ilike ${p} or vat_number ilike ${p} or tax_code ilike ${p}` +
        ` or email ilike ${p} or city ilike ${p})`,
    )
  }
  return { where, values }
}

const KIND_LABELS: Record<string, string> = {
  company: 'Impresa',
  person: 'Privato',
  public_body: 'Ente pubblico',
}

function sendClient(reply: FastifyReply, row: ClientRow, status = 200) {
  return reply.code(status).header('ETag', etagOf(row)).send(toContract(row))
}

export function clientRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/clients',
    async (request) => {
      const session = requireSession(request)
      const list = readList(request.query)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('clients.view')) throw forbidden()

        const { where, values } = listFilter(list)
        values.push(list.perPage, (list.page - 1) * list.perPage)
        const { rows } = await client.query<ClientRow & { total: number }>(
          `select ${COLUMNS}, count(*) over ()::int as total
           from public.clients
           where ${where.join(' and ')}
           order by ${SORTS[list.sort]}
           limit $${values.length - 1} offset $${values.length}`,
          values,
        )
        let total = rows[0]?.total
        if (total === undefined) {
          // A page past the end has no rows to carry the total.
          const count = await client.query<{ total: number }>(
            `select count(*)::int as total from public.clients where ${where.join(' and ')}`,
            values.slice(0, -2),
          )
          total = count.rows[0]?.total ?? 0
        }
        return {
          data: rows.map(toContract),
          meta: { total, page: list.page, per_page: list.perPage },
        }
      })
    },
  )

  csvScope(app, config, (scope) => {
    scope.post<{ Params: Params }>('/api/companies/:company/clients/import', async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('clients.create')) throw forbidden()
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(415, 'Il corpo deve essere un file CSV (text/csv).')
        }
        let clients
        try {
          clients = parseClientsCsv(body)
        } catch (error) {
          if (error instanceof ImportFailed) throw new ValidationFailed(error.errors)
          throw error
        }
        // One savepoint per row, so a duplicate tax id is reported on its row like createClient.
        const errors = new RowErrors()
        const columns = CLIENT_FIELDS.join(', ')
        const placeholders = CLIENT_FIELDS.map((_, i) => `$${i + 1}`).join(', ')
        for (const { line, input } of clients) {
          await client.query('savepoint import_row')
          try {
            await client.query(
              `insert into public.clients (company_id, ${columns})
               values (app.current_company_id(), ${placeholders})`,
              CLIENT_FIELDS.map((field) => input[field]),
            )
            await client.query('release savepoint import_row')
          } catch (error) {
            const duplicate = isUniqueViolation(error) ? duplicateErrors(error) : null
            if (!duplicate) throw error
            await client.query('rollback to savepoint import_row')
            errors.add(line, rowMessages(duplicate))
          }
        }
        if (!errors.empty) throw new ValidationFailed(errors.errors)
        return { created: clients.length }
      })
    })
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/clients/export',
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('clients.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<ClientRow>(
          `select ${COLUMNS} from public.clients
           where ${where.join(' and ')}
           order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Tipo',
            'Nome',
            'Partita IVA',
            'Codice fiscale',
            'Email',
            'PEC',
            'Telefono',
            'Codice destinatario',
            'Indirizzo',
            'CAP',
            'Città',
            'Provincia',
            'Paese',
            'Note',
          ],
          rows.map((r) => [
            KIND_LABELS[r.kind] ?? r.kind,
            r.name,
            r.vat_number,
            r.tax_code,
            r.email,
            r.pec,
            r.phone,
            r.sdi_code,
            r.street,
            r.postal_code,
            r.city,
            r.province,
            r.country,
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="clienti.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>('/api/companies/:company/clients/:client', async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      // Without the permission the client is "not found", as the contract says.
      if (!permissions.has('clients.view')) throw notFound()
      const id = request.params.client ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<ClientRow>(
        `select ${COLUMNS} from public.clients where id = $1`,
        [id],
      )
      return rows[0]
    })
    if (!row) throw notFound()
    return sendClient(reply, row)
  })

  app.post<{ Params: Params }>('/api/companies/:company/clients', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('clients.create')) throw forbidden()
      const parsed = parseClientInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)

      const values = CLIENT_FIELDS.map((field) => parsed.input[field])
      try {
        const { rows } = await client.query<ClientRow>(
          `insert into public.clients (company_id, ${CLIENT_FIELDS.join(', ')})
           values (app.current_company_id(), ${CLIENT_FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
           returning ${COLUMNS}`,
          values,
        )
        return rows[0]
      } catch (error) {
        const duplicate = isUniqueViolation(error) ? duplicateErrors(error) : null
        if (duplicate) throw new ValidationFailed(duplicate)
        throw error
      }
    })
    if (!row) throw new Error('insert returned no row')
    return sendClient(reply, row, 201)
  })

  app.put<{ Params: Params }>('/api/companies/:company/clients/:client', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('clients.update')) throw forbidden()
      const id = request.params.client ?? ''
      if (!UUID.test(id)) throw notFound()

      const ifMatch = requireIfMatch(request.headers['if-match'])
      const parsed = parseClientInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)

      const version = expectedVersion(ifMatch)
      const values: unknown[] = CLIENT_FIELDS.map((field) => parsed.input[field])
      values.push(id, version ?? -1)
      try {
        const { rows } = await client.query<ClientRow>(
          `update public.clients
           set ${CLIENT_FIELDS.map((field, i) => `${field} = $${i + 1}`).join(', ')},
               version = version + 1, updated_at = now()
           where id = $${values.length - 1} and version = $${values.length}
           returning ${COLUMNS}`,
          values,
        )
        if (rows[0]) return rows[0]
      } catch (error) {
        const duplicate = isUniqueViolation(error) ? duplicateErrors(error) : null
        if (duplicate) throw new ValidationFailed(duplicate)
        throw error
      }
      return missingOrStale(client, id)
    })
    return sendClient(reply, row)
  })

  const setArchived = (action: 'archive' | 'restore') =>
    app.post<{ Params: Params }>(
      `/api/companies/:company/clients/:client/${action}`,
      async (request, reply) => {
        const session = requireSession(request)
        checkCsrf(config, request)
        const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
          const permissions = await enterCompany(client, request.params.company)
          if (!permissions.has('clients.update')) throw forbidden()
          const id = request.params.client ?? ''
          if (!UUID.test(id)) throw notFound()
          const version = expectedVersion(requireIfMatch(request.headers['if-match']))
          const { rows } = await client.query<ClientRow>(
            `update public.clients
             set archived_at = ${action === 'archive' ? 'coalesce(archived_at, now())' : 'null'},
                 version = version + 1, updated_at = now()
             where id = $1 and version = $2
             returning ${COLUMNS}`,
            [id, version ?? -1],
          )
          return rows[0] ?? missingOrStale(client, id)
        })
        return sendClient(reply, row)
      },
    )
  setArchived('archive')
  setArchived('restore')

  app.delete<{ Params: Params }>(
    '/api/companies/:company/clients/:client',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('clients.delete')) throw forbidden()
        const id = request.params.client ?? ''
        if (!UUID.test(id)) throw notFound()
        const version = expectedVersion(requireIfMatch(request.headers['if-match']))
        try {
          const { rowCount } = await client.query(
            'delete from public.clients where id = $1 and version = $2',
            [id, version ?? -1],
          )
          if (rowCount) return
        } catch (error) {
          // Documents reference clients with "on delete restrict": the database says no.
          if (isForeignKeyViolation(error)) {
            throw new ApiError(409, messages.clientHasDocuments, 'has_documents')
          }
          throw error
        }
        await missingOrStale(client, id)
      })
      return reply.code(204).send()
    },
  )
}

function requireIfMatch(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.missingIfMatch, 'precondition_required')
  }
  return header
}

/** Nothing changed: either the client is not visible here, or someone changed it first. */
async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  const { rowCount } = await client.query('select 1 from public.clients where id = $1', [id])
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.staleRecord, 'stale_record')
}
