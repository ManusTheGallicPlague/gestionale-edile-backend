import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { notFound } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { siteSignPdf } from '../sites/sign-pdf.js'
import { readProfile } from './settings.js'
import { onSite } from './site-subcontractors.js'
import { readSite } from './sites.js'

type Params = { company: string; site: string }

/** The site sign (cartello di cantiere) in PDF. */
export function siteSignRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: Params }>(
    '/api/companies/:company/sites/:site/sign/pdf',
    async (request, reply) => {
      const session = requireSession(request)
      const sign = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('sites.view')) throw notFound()
        const id = request.params.site
        if (!UUID.test(id)) throw notFound()
        const site = await readSite(client, id, permissions)
        if (!site) throw notFound()
        const profile = await readProfile(client)
        let subcontractors: { name: string; vat_number: string | null }[] | null = null
        if (permissions.has('suppliers.view')) {
          const { rows } = await client.query<{ name: string; vat_number: string | null }>(
            `select name, vat_number from public.suppliers
             where ${onSite('$1')} order by lower(name), id`,
            [id],
          )
          subcontractors = rows
        }
        return {
          code: site.code,
          buffer: siteSignPdf({
            site: {
              name: site.name,
              address: site.address,
              client: site.client_id ? site.client_name : null,
              permit: site.permit,
              cig: site.cig,
              cup: site.cup,
              works_director: site.works_director,
              safety_coordinator: site.safety_coordinator,
              prior_notice_on: site.prior_notice_on,
              start_on: site.start_on,
              end_on: site.end_on,
            },
            company: {
              name: profile.legal_name,
              street: profile.street,
              postal_code: profile.postal_code,
              city: profile.city,
              province: profile.province,
              vat_number: profile.vat_number,
              tax_code: profile.tax_code,
            },
            subcontractors,
          }),
        }
      })
      const name = sign.code ? sign.code.replace(/[^A-Za-z0-9-]+/g, '-') : 'cantiere'
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="cartello-${name}.pdf"`)
        .header('Cache-Control', 'private, no-store')
        .send(sign.buffer)
    },
  )
}
