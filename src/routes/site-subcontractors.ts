import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { italianDate, toCsv } from '../csv.js'
import { UUID } from '../deadlines/input.js'
import { forbidden, notFound } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { DOCUMENT_KINDS, type DocumentKind } from '../suppliers/documents.js'
import { KIND_LABEL } from './supplier-documents.js'
import { siteExists } from './site-team.js'
import { COMPLIANCE_SQL } from './suppliers.js'

type Params = { company: string; site: string }

interface SubcontractorRow {
  id: string
  name: string
  vat_number: string | null
  archived_at: Date | null
  documents_expired: boolean
  documents_expiring: boolean
  no_valid_durc: boolean
}

/**
 * Subcontractors with a cost or an order on the site `site` (a parameter or a column); the
 * table keeps the name `suppliers`, without alias, for COMPLIANCE_SQL.
 */
export const onSite = (site: string) => `suppliers.subcontractor
  and (exists (select 1 from public.site_costs c
               where c.site_id = ${site} and c.supplier_id = suppliers.id)
    or exists (select 1 from public.purchase_orders o
               where o.site_id = ${site} and o.supplier_id = suppliers.id))`

/** Sites of a supplier or an employee: in progress first, then planned, suspended, closed. */
export const SITES_ORDER = `array_position(array['active', 'planned', 'suspended', 'completed'],
  s.status::text), lower(s.name), s.id`

export interface SupplierSiteRow {
  id: string
  code: string | null
  name: string
  status: string
}

interface Row {
  name: string
  vat_number: string | null
  kind: DocumentKind | null
  description: string | null
  issued_on: string | null
  expires_on: string | null
  notes: string | null
  status: string
  has_file: boolean
}

/**
 * The subcontractors that worked on the site (a cost or an order on it) with every document,
 * for the safety coordinator, as the documents of the team. No amounts: only who they are.
 */
export function siteSubcontractorRoutes(app: FastifyInstance, db: Db): void {
  const url = '/api/companies/:company/sites/:site/subcontractors/documents/export'

  app.get<{ Params: Params }>(
    '/api/companies/:company/sites/:site/subcontractors',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('sites.view')) throw notFound()
        const id = request.params.site
        if (!UUID.test(id) || !(await siteExists(client, id))) throw notFound()
        if (!permissions.has('suppliers.view')) throw forbidden()
        const { rows } = await client.query<SubcontractorRow>(
          `select id, name, vat_number, archived_at,
             ${COMPLIANCE_SQL.expired} as documents_expired,
             ${COMPLIANCE_SQL.expiring} as documents_expiring,
             ${COMPLIANCE_SQL.no_valid_durc} as no_valid_durc
           from public.suppliers
           where ${onSite('$1')}
           order by lower(name), id`,
          [id],
        )
        return {
          data: rows.map((r) => ({
            supplier_id: r.id,
            name: r.name,
            vat_number: r.vat_number,
            archived: r.archived_at !== null,
            documents_expired: r.documents_expired,
            documents_expiring: r.documents_expiring,
            no_valid_durc: r.no_valid_durc,
          })),
        }
      })
    },
  )

  // The other way round: the sites of a supplier (any, not only subcontractors).
  app.get<{ Params: { company: string; supplier: string } }>(
    '/api/companies/:company/suppliers/:supplier/sites',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('suppliers.view')) throw notFound()
        const id = request.params.supplier
        if (!UUID.test(id)) throw notFound()
        const found = await client.query('select 1 from public.suppliers where id = $1', [id])
        if (found.rowCount === 0) throw notFound()
        if (!permissions.has('sites.view')) throw forbidden()
        const { rows } = await client.query<SupplierSiteRow>(
          `select s.id, s.code, s.name, s.status
           from public.sites s
           where exists (select 1 from public.site_costs c
                         where c.site_id = s.id and c.supplier_id = $1)
              or exists (select 1 from public.purchase_orders o
                         where o.site_id = s.id and o.supplier_id = $1)
           order by ${SITES_ORDER}`,
          [id],
        )
        return {
          data: rows.map((r) => ({ site_id: r.id, code: r.code, name: r.name, status: r.status })),
        }
      })
    },
  )

  app.get<{ Params: Params }>(url, async (request, reply) => {
    const session = requireSession(request)
    const csv = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('sites.view')) throw notFound()
      const id = request.params.site
      if (!UUID.test(id) || !(await siteExists(client, id))) throw notFound()
      if (!permissions.has('suppliers.view')) throw forbidden()
      const { rows } = await client.query<Row>(
        `select s.name, s.vat_number, d.kind, d.description,
           d.issued_on::text as issued_on, d.expires_on::text as expires_on, d.notes,
           case
             when d.id is null then 'Nessun documento'
             when d.expires_on is null then 'Senza scadenza'
             when exists (
               select 1 from public.supplier_documents n
               where n.supplier_id = d.supplier_id and n.kind = d.kind
                 and n.expires_on > d.expires_on
             ) then 'Rinnovato'
             when d.expires_on < (now() at time zone 'Europe/Rome')::date then 'Scaduto'
             when d.expires_on <= (now() at time zone 'Europe/Rome')::date + 30 then 'In scadenza'
             else 'Valido'
           end as status,
           exists (select 1 from public.supplier_document_files f where f.document_id = d.id)
             as has_file
         from public.suppliers s
         left join public.supplier_documents d on d.supplier_id = s.id
         where s.subcontractor
           and (exists (select 1 from public.site_costs c where c.site_id = $1 and c.supplier_id = s.id)
             or exists (select 1 from public.purchase_orders o
                        where o.site_id = $1 and o.supplier_id = s.id))
         order by lower(s.name), s.id, array_position($2::text[], d.kind),
           d.expires_on desc nulls first, d.id`,
        [id, DOCUMENT_KINDS],
      )
      return toCsv(
        [
          'Subappaltatore',
          'Partita IVA',
          'Documento',
          'Descrizione',
          'Rilascio',
          'Scadenza',
          'Stato',
          'Note',
          'File',
        ],
        rows.map((r) => [
          r.name,
          r.vat_number,
          r.kind && KIND_LABEL[r.kind],
          r.description,
          r.issued_on && italianDate(r.issued_on),
          r.expires_on && italianDate(r.expires_on),
          r.status,
          r.notes,
          r.kind && (r.has_file ? 'Sì' : 'No'),
        ]),
      )
    })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="documenti-subappaltatori.csv"')
      .send(csv)
  })
}
