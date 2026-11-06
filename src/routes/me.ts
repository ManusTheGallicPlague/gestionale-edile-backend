import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { requireSession } from '../http/request-context.js'
import { isPermission } from '../permissions.js'

export function meRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/me', async (request) => {
    const session = requireSession(request)
    const companies = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const { rows } = await client.query<{
        slug: string
        name: string
        role: string
        permissions: string[]
      }>(
        `select c.slug, c.name, r.name as role,
                coalesce(array_agg(rp.permission order by rp.permission)
                  filter (where rp.permission is not null), '{}') as permissions
         from public.memberships m
         join public.companies c on c.id = m.company_id
         join public.roles r on r.id = m.role_id
         left join public.role_permissions rp on rp.role_id = r.id
         where m.user_id = app.current_user_id() and m.disabled_at is null
         group by c.slug, c.name, r.name
         order by c.name`,
      )
      return rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        role: row.role,
        // Only permissions the contract knows: the frontend's types are generated from it.
        permissions: row.permissions.filter(isPermission),
      }))
    })
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      companies,
    }
  })
}
