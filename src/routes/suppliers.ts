import { MAX_EXPORT_ROWS, toCsv } from '../csv.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { isForeignKeyViolation, isUniqueViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import {
  SUPPLIER_CATEGORIES,
  SUPPLIER_FIELDS,
  parseSupplierInput,
  type SupplierInput,
} from '../suppliers/input.js'
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
import { RowErrors } from '../clients/import.js'
import { parseSuppliersCsv, supplierRowMessages } from '../suppliers/import.js'

interface SupplierRow extends SupplierInput {
  id: string
  archived_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, ${SUPPLIER_FIELDS.join(', ')}, archived_at, version, created_at, updated_at`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SORTS = {
  name: 'lower(name) asc, id asc',
  '-name': 'lower(name) desc, id desc',
  created_at: 'created_at asc, id asc',
  '-created_at': 'created_at desc, id desc',
} as const

type Params = { company: string; supplier?: string }

function toContract(row: SupplierRow) {
  const supplier: Record<string, unknown> = { id: row.id }
  for (const field of SUPPLIER_FIELDS) supplier[field] = row[field]
  supplier.archived_at = row.archived_at?.toISOString() ?? null
  supplier.created_at = row.created_at.toISOString()
  supplier.updated_at = row.updated_at.toISOString()
  return supplier
}

function expectedVersion(header: string): number | null {
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : null
}

function requireIfMatch(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.supplierMissingIfMatch, 'precondition_required')
  }
  return header
}

/** Nothing changed: either the supplier is not visible here, or someone changed it first. */
async function missingOrStale(client: PoolClient, id: string): Promise<never> {
  const { rowCount } = await client.query('select 1 from public.suppliers where id = $1', [id])
  if (!rowCount) throw notFound()
  throw new ApiError(412, messages.supplierStale, 'stale_record')
}

function duplicateErrors(error: { constraint?: string | undefined }): FieldErrors | null {
  if (error.constraint === 'suppliers_vat_number_key') {
    return { vat_number: ['Esiste già un fornitore con questa partita IVA.'] }
  }
  if (error.constraint === 'suppliers_tax_code_key') {
    return { tax_code: ['Esiste già un fornitore con questo codice fiscale.'] }
  }
  return null
}

const COMPLIANCE = ['expired', 'expiring', 'no_valid_durc'] as const

const TODAY = "(now() at time zone 'Europe/Rome')::date"

/**
 * The latest expiry of each kind of compliance document of the supplier: an older DURC that
 * expired does not count once a newer one is on file. Documents without expiry are left out.
 */
const LATEST_EXPIRIES = `
  select max(d.expires_on) as expires_on from public.supplier_documents d
  where d.supplier_id = suppliers.id and d.expires_on is not null group by d.kind`

export const COMPLIANCE_SQL: Record<(typeof COMPLIANCE)[number], string> = {
  expired: `exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on < ${TODAY})`,
  expiring: `not exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on < ${TODAY})
    and exists (select 1 from (${LATEST_EXPIRIES}) l where l.expires_on <= ${TODAY} + 30)`,
  no_valid_durc: `not exists (select 1 from public.supplier_documents d
    where d.supplier_id = suppliers.id and d.kind = 'durc'
      and (d.expires_on is null or d.expires_on >= ${TODAY}))`,
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
  const boolean = (name: string): boolean | undefined => {
    const value = single(name)
    if (value === undefined) return undefined
    if (value !== 'true' && value !== 'false') {
      errors[name] = ['Vale true oppure false.']
      return undefined
    }
    return value === 'true'
  }

  const page = integer('page', 1)
  const perPage = integer('per_page', 25, 100)
  const sortValue = single('sort') ?? 'name'
  const sort = sortValue in SORTS ? (sortValue as keyof typeof SORTS) : undefined
  if (!sort) errors.sort = ['Ordinamento non valido.']
  const search = single('search')?.trim() ?? ''
  if (search.length > 100) errors.search = ['Al massimo 100 caratteri.']
  const categoryValue = single('filter[category]')
  const category =
    categoryValue === undefined ? undefined : SUPPLIER_CATEGORIES.find((c) => c === categoryValue)
  if (categoryValue !== undefined && !category) {
    errors['filter[category]'] = ['Categoria non valida.']
  }
  const subcontractor = boolean('filter[subcontractor]')
  const archived = boolean('filter[archived]') ?? false
  const complianceValue = single('filter[compliance]')
  const compliance =
    complianceValue === undefined ? undefined : COMPLIANCE.find((c) => c === complianceValue)
  if (complianceValue !== undefined && !compliance) {
    errors['filter[compliance]'] = ['Vale expired, expiring oppure no_valid_durc.']
  }

  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    page,
    perPage,
    sort: sort ?? 'name',
    search,
    category,
    subcontractor,
    archived,
    compliance,
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function listFilter(list: ReturnType<typeof readList>) {
  const where = [list.archived ? 'archived_at is not null' : 'archived_at is null']
  const values: unknown[] = []
  if (list.category) {
    values.push(list.category)
    where.push(`$${values.length} = any (categories)`)
  }
  if (list.subcontractor !== undefined) {
    values.push(list.subcontractor)
    where.push(`subcontractor = $${values.length}`)
  }
  if (list.compliance) where.push(COMPLIANCE_SQL[list.compliance])
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

const CATEGORY_LABELS: Record<string, string> = {
  materials: 'Materiali',
  rentals: 'Noli',
  subcontracting: 'Subappalto',
  services: 'Servizi',
  other: 'Altro',
}

function sendSupplier(reply: FastifyReply, row: SupplierRow, status = 200) {
  return reply.code(status).header('ETag', `"${row.version}"`).send(toContract(row))
}

export function supplierRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/suppliers'

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(base, async (request) => {
    const session = requireSession(request)
    const list = readList(request.query)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.view')) throw forbidden()

      const { where, values } = listFilter(list)
      values.push(list.perPage, (list.page - 1) * list.perPage)
      const { rows } = await client.query<SupplierRow & { total: number }>(
        `select ${COLUMNS}, count(*) over ()::int as total
         from public.suppliers
         where ${where.join(' and ')}
         order by ${SORTS[list.sort]}
         limit $${values.length - 1} offset $${values.length}`,
        values,
      )
      let total = rows[0]?.total
      if (total === undefined) {
        const count = await client.query<{ total: number }>(
          `select count(*)::int as total from public.suppliers where ${where.join(' and ')}`,
          values.slice(0, -2),
        )
        total = count.rows[0]?.total ?? 0
      }
      return {
        data: rows.map(toContract),
        meta: { total, page: list.page, per_page: list.perPage },
      }
    })
  })

  csvScope(app, config, (scope) => {
    scope.post<{ Params: Params }>(`${base}/import`, async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('suppliers.create')) throw forbidden()
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(415, 'Il corpo deve essere un file CSV (text/csv).')
        }
        let suppliers
        try {
          suppliers = parseSuppliersCsv(body)
        } catch (error) {
          if (error instanceof ImportFailed) throw new ValidationFailed(error.errors)
          throw error
        }
        // One savepoint per row, so a duplicate tax id is reported on its row.
        const errors = new RowErrors()
        const columns = SUPPLIER_FIELDS.join(', ')
        const placeholders = SUPPLIER_FIELDS.map((_, i) => `$${i + 1}`).join(', ')
        for (const { line, input } of suppliers) {
          await client.query('savepoint import_row')
          try {
            await client.query(
              `insert into public.suppliers (company_id, ${columns})
               values (app.current_company_id(), ${placeholders})`,
              SUPPLIER_FIELDS.map((field) => input[field]),
            )
            await client.query('release savepoint import_row')
          } catch (error) {
            const duplicate = isUniqueViolation(error) ? duplicateErrors(error) : null
            if (!duplicate) throw error
            await client.query('rollback to savepoint import_row')
            errors.add(line, supplierRowMessages(duplicate))
          }
        }
        if (!errors.empty) throw new ValidationFailed(errors.errors)
        return { created: suppliers.length }
      })
    })
  })

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/export`,
    async (request, reply) => {
      const session = requireSession(request)
      const list = readList(request.query)
      const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('suppliers.view')) throw forbidden()
        const { where, values } = listFilter(list)
        values.push(MAX_EXPORT_ROWS)
        const { rows } = await client.query<SupplierRow>(
          `select ${COLUMNS} from public.suppliers
           where ${where.join(' and ')}
           order by ${SORTS[list.sort]}
           limit $${values.length}`,
          values,
        )
        return toCsv(
          [
            'Nome',
            'Partita IVA',
            'Codice fiscale',
            'Email',
            'PEC',
            'Telefono',
            'Indirizzo',
            'CAP',
            'Città',
            'Provincia',
            'Paese',
            'Categorie',
            'Subappaltatore',
            'Note',
          ],
          rows.map((r) => [
            r.name,
            r.vat_number,
            r.tax_code,
            r.email,
            r.pec,
            r.phone,
            r.street,
            r.postal_code,
            r.city,
            r.province,
            r.country,
            r.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', '),
            r.subcontractor ? 'Sì' : 'No',
            r.notes,
          ]),
        )
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="fornitori.csv"')
        .send(csv)
    },
  )

  app.get<{ Params: Params }>(`${base}/:supplier`, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.view')) throw notFound()
      const id = request.params.supplier ?? ''
      if (!UUID.test(id)) throw notFound()
      const { rows } = await client.query<SupplierRow>(
        `select ${COLUMNS} from public.suppliers where id = $1`,
        [id],
      )
      return rows[0]
    })
    if (!row) throw notFound()
    return sendSupplier(reply, row)
  })

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.create')) throw forbidden()
      const parsed = parseSupplierInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values = SUPPLIER_FIELDS.map((field) => parsed.input[field])
      try {
        const { rows } = await client.query<SupplierRow>(
          `insert into public.suppliers (company_id, ${SUPPLIER_FIELDS.join(', ')})
           values (app.current_company_id(), ${SUPPLIER_FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
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
    return sendSupplier(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/:supplier`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.update')) throw forbidden()
      const id = request.params.supplier ?? ''
      if (!UUID.test(id)) throw notFound()
      const ifMatch = requireIfMatch(request.headers['if-match'])
      const parsed = parseSupplierInput(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)

      const values: unknown[] = SUPPLIER_FIELDS.map((field) => parsed.input[field])
      values.push(id, expectedVersion(ifMatch) ?? -1)
      try {
        const { rows } = await client.query<SupplierRow>(
          `update public.suppliers
           set ${SUPPLIER_FIELDS.map((field, i) => `${field} = $${i + 1}`).join(', ')},
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
    return sendSupplier(reply, row)
  })

  for (const action of ['archive', 'restore'] as const) {
    app.post<{ Params: Params }>(`${base}/:supplier/${action}`, async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('suppliers.update')) throw forbidden()
        const id = request.params.supplier ?? ''
        if (!UUID.test(id)) throw notFound()
        const version = expectedVersion(requireIfMatch(request.headers['if-match']))
        const { rows } = await client.query<SupplierRow>(
          `update public.suppliers
           set archived_at = ${action === 'archive' ? 'coalesce(archived_at, now())' : 'null'},
               version = version + 1, updated_at = now()
           where id = $1 and version = $2
           returning ${COLUMNS}`,
          [id, version ?? -1],
        )
        return rows[0] ?? missingOrStale(client, id)
      })
      return sendSupplier(reply, row)
    })
  }

  app.delete<{ Params: Params }>(`${base}/:supplier`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('suppliers.delete')) throw forbidden()
      const id = request.params.supplier ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(requireIfMatch(request.headers['if-match']))
      try {
        const { rowCount } = await client.query(
          'delete from public.suppliers where id = $1 and version = $2',
          [id, version ?? -1],
        )
        if (rowCount) return
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new ApiError(409, messages.supplierHasDocuments, 'has_documents')
        }
        throw error
      }
      await missingOrStale(client, id)
    })
    return reply.code(204).send()
  })
}
