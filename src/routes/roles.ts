import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ApiError, ValidationFailed, forbidden, notFound } from '../http/errors.js'
import { UUID } from '../deadlines/input.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { isPermission } from '../permissions.js'

export function roleRoutes(app: FastifyInstance, config: Config, db: Db): void {
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
      const { rows } = await client.query<MemberRow>(
        'select * from app.company_members() order by name, user_id',
      )
      return { data: rows.map(presentMember) }
    })
  })

  type MemberParams = { Params: { company: string; user: string } }

  /** Applies a change to a member, then checks someone active can still manage users. */
  async function changeMember(
    request: FastifyRequest<MemberParams>,
    change: (
      client: pg.PoolClient,
      userId: string,
      me: string,
    ) => Promise<[string | null, boolean | null]>,
  ) {
    const session = requireSession(request)
    checkCsrf(config, request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('users.manage')) throw forbidden()
      const userId = request.params.user
      if (!UUID.test(userId)) throw notFound()
      const [roleId, active] = await change(client, userId, session.user.id)
      const { rows: done } = await client.query<{ found: boolean }>(
        'select app.update_company_member($1, $2, $3) as found',
        [userId, roleId, active],
      )
      if (!done[0]?.found) throw notFound()
      const { rows: managers } = await client.query<{ n: number }>(
        `select count(*)::int as n from app.company_members() cm
         where cm.active and exists (
           select 1 from public.role_permissions rp
           where rp.role_id = cm.role_id and rp.permission = 'users.manage')`,
      )
      // Throwing rolls the change back.
      if ((managers[0]?.n ?? 0) === 0) throw new ApiError(409, LAST_MANAGER, 'last_manager')
      const { rows } = await client.query<MemberRow>(
        'select * from app.company_members() where user_id = $1',
        [userId],
      )
      const row = rows[0]
      if (!row) throw notFound()
      return presentMember(row)
    })
  }

  app.put<MemberParams>('/api/companies/:company/users/:user/role', (request) =>
    changeMember(request, async (client) => {
      const raw = (
        typeof request.body === 'object' && request.body !== null ? request.body : {}
      ) as Record<string, unknown>
      const roleId = typeof raw.role_id === 'string' ? raw.role_id : ''
      if (!roleId) throw new ValidationFailed({ role_id: ['Scegli il ruolo.'] })
      const role = UUID.test(roleId)
        ? await client.query(
            'select 1 from public.roles where id = $1 and company_id = app.current_company_id()',
            [roleId],
          )
        : { rowCount: 0 }
      if (role.rowCount === 0) throw new ValidationFailed({ role_id: ['Ruolo non trovato.'] })
      return [roleId, null]
    }),
  )

  app.post<MemberParams>('/api/companies/:company/users/:user/deactivate', (request) =>
    changeMember(request, (_client, userId, me) => {
      if (userId === me) throw new ApiError(409, SELF_DEACTIVATION, 'self_deactivation')
      return Promise.resolve([null, false])
    }),
  )

  app.post<MemberParams>('/api/companies/:company/users/:user/reactivate', (request) =>
    changeMember(request, () => Promise.resolve([null, true])),
  )
}

const LAST_MANAGER =
  'Dopo questo cambio nessun utente attivo potrebbe più gestire gli utenti: prima dai il permesso a qualcun altro.'
const SELF_DEACTIVATION = 'Non puoi disattivare te stesso: chiedi a un altro amministratore.'

interface MemberRow {
  user_id: string
  name: string
  email: string
  active: boolean
  role_id: string
  role_name: string
  joined_at: Date
}

function presentMember(r: MemberRow) {
  return {
    id: r.user_id,
    name: r.name,
    email: r.email,
    active: r.active,
    role: { id: r.role_id, name: r.role_name },
    joined_at: r.joined_at.toISOString(),
  }
}
