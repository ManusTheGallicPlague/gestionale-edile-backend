import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { forbidden } from '../http/errors.js'
import { requireSession } from '../http/request-context.js'
import { isPermission } from '../permissions.js'

export function roleRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { company: string } }>('/api/companies/:company/roles', async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('users.view')) throw forbidden()
      // The policy on roles shows every company of the user: filter on the one in the URL.
      const { rows } = await client.query<{ id: string; name: string; permissions: string[] }>(
        `select r.id, r.name,
           coalesce(array_agg(rp.permission order by rp.permission)
             filter (where rp.permission is not null), '{}') as permissions
         from public.roles r
         left join public.role_permissions rp on rp.role_id = r.id
         where r.company_id = app.current_company_id()
         group by r.id, r.name
         order by r.name, r.id`,
      )
      // Permissions no longer in the catalog stay out, as in /api/me.
      return {
        data: rows.map((r) => ({ ...r, permissions: r.permissions.filter(isPermission) })),
      }
    })
  })

  app.get<{ Params: { company: string } }>('/api/companies/:company/users', async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('users.view')) throw forbidden()
      const { rows } = await client.query<{
        user_id: string
        name: string
        email: string
        active: boolean
        role_id: string
        role_name: string
        joined_at: Date
      }>('select * from app.company_members() order by name, user_id')
      return {
        data: rows.map((r) => ({
          id: r.user_id,
          name: r.name,
          email: r.email,
          active: r.active,
          role: { id: r.role_id, name: r.role_name },
          joined_at: r.joined_at.toISOString(),
        })),
      }
    })
  })
}
