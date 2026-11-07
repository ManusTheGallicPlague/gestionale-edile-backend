import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import type { Permission } from '../permissions.js'

const PER_TYPE = 5

/** A sequence number as users read it: at least three digits, never cut. */
const seq = (column: string) => `lpad(${column}::text, greatest(3, length(${column}::text)), '0')`

const QUOTE_NUMBER = `case when q.number_year is null then null else q.number_year::text || '/' ||
  ${seq('q.number_seq')} || coalesce('-R' || nullif(q.revision, 0)::text, '') end`

const ORDER_NUMBER = `o.number_year::text || '/' || ${seq('o.number_seq')}`

/**
 * One query per type, filtering on $1 (the contains pattern). Each selects id, title and
 * subtitle, and parent_id when the hit lives inside something else; prefix ordering uses $2.
 */
const TYPES: { type: string; permission: Permission; sql: string; parent?: true }[] = [
  {
    type: 'client',
    permission: 'clients.view',
    sql: `select id, name as title, city as subtitle from public.clients
      where archived_at is null and (name ilike $1 or vat_number ilike $1 or tax_code ilike $1
        or email ilike $1)`,
  },
  {
    type: 'supplier',
    permission: 'suppliers.view',
    sql: `select id, name as title, city as subtitle from public.suppliers
      where archived_at is null and (name ilike $1 or vat_number ilike $1 or tax_code ilike $1
        or email ilike $1)`,
  },
  {
    type: 'site',
    permission: 'sites.view',
    sql: `select id, name as title, code as subtitle from public.sites
      where name ilike $1 or code ilike $1 or address ilike $1`,
  },
  {
    type: 'quote',
    permission: 'quotes.view',
    sql: `select * from (select q.id, q.subject as title, ${QUOTE_NUMBER} as subtitle
      from public.quotes q) x where title ilike $1 or subtitle ilike $1`,
  },
  {
    type: 'estimate',
    permission: 'estimates.view',
    sql: `select e.id, e.title, c.name as subtitle from public.estimates e
      left join public.clients c on c.id = e.client_id
      where e.title ilike $1`,
  },
  {
    type: 'invoice',
    permission: 'invoices.view',
    sql: `select id, number as title, description as subtitle from public.invoices
      where number ilike $1 or description ilike $1`,
  },
  {
    type: 'purchase_order',
    permission: 'purchases.view',
    sql: `select * from (select o.id, ${ORDER_NUMBER} as title, s.name as subtitle
      from public.purchase_orders o join public.suppliers s on s.id = o.supplier_id) x
      where title ilike $1 or subtitle ilike $1`,
  },
  {
    type: 'employee',
    permission: 'employees.view',
    sql: `select * from (select id, last_name || ' ' || first_name as title,
        job_title as subtitle, first_name || ' ' || last_name as other, tax_code
      from public.employees) x
      where title ilike $1 or other ilike $1 or tax_code ilike $1`,
  },
  {
    type: 'vehicle',
    permission: 'vehicles.view',
    sql: `select id, name as title, plate as subtitle from public.vehicles
      where name ilike $1 or plate ilike $1`,
  },
  {
    type: 'deadline',
    permission: 'deadlines.view',
    sql: `select id, title, to_char(due_on, 'DD/MM/YYYY') as subtitle from public.deadlines
      where title ilike $1`,
  },
  {
    type: 'price_list_item',
    permission: 'price_lists.view',
    parent: true,
    sql: `select id, price_list_id as parent_id, description as title, code as subtitle
      from public.price_list_items where code ilike $1 or description ilike $1`,
  },
  {
    type: 'site_document',
    permission: 'documents.view',
    parent: true,
    sql: `select d.id, d.site_id as parent_id, d.title, s.name as subtitle
      from public.site_documents d join public.sites s on s.id = d.site_id
      where d.title ilike $1 or d.file_name ilike $1`,
  },
  {
    type: 'warehouse_item',
    permission: 'warehouse.view',
    sql: `select id, name as title, code as subtitle from public.warehouse_items
      where name ilike $1 or code ilike $1`,
  },
  {
    type: 'site_activity',
    permission: 'sites.view',
    parent: true,
    sql: `select a.id, a.site_id as parent_id, a.name as title, s.name as subtitle
      from public.site_activities a join public.sites s on s.id = a.site_id
      where a.name ilike $1`,
  },
]

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

function readQuery(query: Record<string, unknown>): string {
  const value = query.q
  if (value === undefined) throw new ValidationFailed({ q: ['Scrivi cosa cercare.'] })
  if (typeof value !== 'string') throw new ValidationFailed({ q: ['Indicalo una volta sola.'] })
  const q = value.trim()
  if (q.length < 2) throw new ValidationFailed({ q: ['Almeno 2 caratteri.'] })
  if (q.length > 100) throw new ValidationFailed({ q: ['Al massimo 100 caratteri.'] })
  return q
}

async function searchType(client: PoolClient, t: (typeof TYPES)[number], q: string) {
  const { rows } = await client.query<Omit<Hit, 'type'>>(
    `select id, ${t.parent ? 'parent_id' : 'null::uuid as parent_id'}, title, subtitle
     from (${t.sql}) x
     order by (title ilike $2) desc, lower(title), id
     limit ${PER_TYPE}`,
    [`%${escapeLike(q)}%`, `${escapeLike(q)}%`],
  )
  return rows
}

interface Hit {
  type: string
  id: string
  parent_id: string | null
  title: string
  subtitle: string | null
}

/** Quick search across the company: only the types the user may see. */
export function searchRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { company: string }; Querystring: Record<string, unknown> }>(
    '/api/companies/:company/search',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        const q = readQuery(request.query)
        const items: Hit[] = []
        for (const t of TYPES) {
          if (!permissions.has(t.permission)) continue
          for (const row of await searchType(client, t, q)) items.push({ type: t.type, ...row })
        }
        return { q, items }
      })
    },
  )
}
