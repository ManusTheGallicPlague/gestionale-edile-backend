import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ApiError, ValidationFailed, forbidden, notFound } from '../http/errors.js'
import type { FieldErrors } from '../http/errors.js'
import { UUID } from '../deadlines/input.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { isPermission, type Permission } from '../permissions.js'

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
      await client.query('select app.lock_company()')
      const before = await managerCounts(client)
      const { rows: done } = await client.query<{ found: boolean }>(
        'select app.update_company_member($1, $2, $3) as found',
        [userId, roleId, active],
      )
      if (!done[0]?.found) throw notFound()
      // Throwing rolls the change back.
      await assertManagersRemain(client, before)
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

  type RoleParams = { Params: { company: string; role: string } }

  app.post<{ Params: { company: string } }>(
    '/api/companies/:company/roles',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const body = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('roles.manage')) throw forbidden()
        const input = readRole(request.body)
        const { rows } = await client.query<{ id: string }>(
          `insert into public.roles (company_id, name) values (app.current_company_id(), $1)
           on conflict (company_id, name) do nothing
           returning id`,
          [input.name],
        )
        const id = rows[0]?.id
        if (!id) throw new ValidationFailed({ name: [DUPLICATE_ROLE] })
        await setPermissions(client, id, input.permissions)
        return { id, name: input.name, permissions: input.permissions }
      })
      return reply.code(201).send(body)
    },
  )

  app.put<RoleParams>('/api/companies/:company/roles/:role', async (request) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('roles.manage')) throw forbidden()
      const id = request.params.role
      if (!UUID.test(id)) throw notFound()
      const input = readRole(request.body)
      await client.query('select app.lock_company()')
      const before = await managerCounts(client)
      const clash = await client.query(
        `select 1 from public.roles
         where company_id = app.current_company_id() and name = $1 and id <> $2`,
        [input.name, id],
      )
      if ((clash.rowCount ?? 0) > 0) throw new ValidationFailed({ name: [DUPLICATE_ROLE] })
      const { rowCount } = await client.query(
        'update public.roles set name = $2 where id = $1 and company_id = app.current_company_id()',
        [id, input.name],
      )
      if (rowCount === 0) throw notFound()
      await client.query('delete from public.role_permissions where role_id = $1', [id])
      await setPermissions(client, id, input.permissions)
      await assertManagersRemain(client, before)
      return { id, name: input.name, permissions: input.permissions }
    })
  })

  app.delete<RoleParams>('/api/companies/:company/roles/:role', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('roles.manage')) throw forbidden()
      const id = request.params.role
      if (!UUID.test(id)) throw notFound()
      try {
        const { rowCount } = await client.query(
          'delete from public.roles where id = $1 and company_id = app.current_company_id()',
          [id],
        )
        if (rowCount === 0) throw notFound()
      } catch (error) {
        if ((error as { code?: string }).code === '23503') {
          throw new ApiError(409, ROLE_IN_USE, 'role_in_use')
        }
        throw error
      }
    })
    return reply.code(204).send()
  })
}

const LAST_MANAGER =
  'Dopo questo cambio nessun utente attivo potrebbe più gestire utenti o ruoli: prima dai il permesso a qualcun altro.'
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

const DUPLICATE_ROLE = 'Esiste già un ruolo con questo nome.'
const ROLE_IN_USE =
  'Il ruolo è assegnato ad almeno un utente: prima dai a quegli utenti un altro ruolo.'

function readRole(body: unknown): { name: string; permissions: Permission[] } {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const errors: FieldErrors = {}
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) errors.name = ['Inserisci il nome del ruolo.']
  else if (name.length > 100) errors.name = ['Al massimo 100 caratteri.']
  const list = raw.permissions
  let permissions: Permission[] = []
  if (!Array.isArray(list) || list.length > 200) {
    errors.permissions = ['Indica i permessi del ruolo (anche nessuno).']
  } else if (!list.every((p): p is Permission => typeof p === 'string' && isPermission(p))) {
    errors.permissions = ['Uno o più permessi non esistono.']
  } else {
    permissions = [...new Set(list)].sort()
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { name, permissions }
}

async function setPermissions(client: pg.PoolClient, roleId: string, permissions: Permission[]) {
  if (permissions.length === 0) return
  await client.query(
    'insert into public.role_permissions (role_id, permission) select $1, unnest($2::text[])',
    [roleId, permissions],
  )
}

const MANAGING: Permission[] = ['users.manage', 'roles.manage']

/** How many active members hold each permission that manages the company's access. */
async function managerCounts(client: pg.PoolClient): Promise<Map<string, number>> {
  const { rows } = await client.query<{ permission: string; n: number }>(
    `select rp.permission, count(*)::int as n
     from app.company_members() cm
     join public.role_permissions rp on rp.role_id = cm.role_id
     where cm.active and rp.permission = any($1::text[])
     group by rp.permission`,
    [MANAGING],
  )
  return new Map(rows.map((r) => [r.permission, r.n]))
}

/**
 * After a change: a managing permission that some active member held must still be held by
 * someone, or nobody could give it back.
 */
async function assertManagersRemain(client: pg.PoolClient, before: Map<string, number>) {
  const after = await managerCounts(client)
  for (const permission of MANAGING) {
    if ((before.get(permission) ?? 0) > 0 && (after.get(permission) ?? 0) === 0) {
      throw new ApiError(409, LAST_MANAGER, 'last_manager')
    }
  }
}
