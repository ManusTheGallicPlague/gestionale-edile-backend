import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import type { Config } from '../config.js'
import { clearFailures, recordFailure, secondsUntilAllowed } from '../auth/login-limits.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import type { SessionUser } from '../auth/sessions.js'
import { ApiError, ValidationFailed, messages, notFound, type FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MIN_PASSWORD_LENGTH } from './invitations.js'
import { isPermission } from '../permissions.js'
import { UUID } from '../deadlines/input.js'

export function meRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get('/api/me', (request) => loadMe(db, requireSession(request).user))

  app.put('/api/me', async (request) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const raw = asObject(request.body)
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) throw new ValidationFailed({ name: ['Inserisci nome e cognome.'] })
    if (name.length > 200) throw new ValidationFailed({ name: ['Al massimo 200 caratteri.'] })
    await db.auth.query('update auth.users set name = $2 where id = $1', [session.user.id, name])
    return loadMe(db, { ...session.user, name })
  })

  app.post('/api/me/password', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const raw = asObject(request.body)
    const current = typeof raw.current_password === 'string' ? raw.current_password : ''
    const next = typeof raw.new_password === 'string' ? raw.new_password : ''
    const errors: FieldErrors = {}
    if (!current) errors.current_password = ['Inserisci la password attuale.']
    else if (current.length > 200) errors.current_password = ['Al massimo 200 caratteri.']
    if (next.length < MIN_PASSWORD_LENGTH) {
      errors.new_password = [`Almeno ${MIN_PASSWORD_LENGTH} caratteri.`]
    } else if (next.length > 200) errors.new_password = ['Al massimo 200 caratteri.']
    if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)

    const { email } = session.user
    const wait = await secondsUntilAllowed(db.auth, config.loginLimits, email, request.ip)
    if (wait !== null) {
      throw new ApiError(429, messages.tooManyAttempts, undefined, { 'Retry-After': String(wait) })
    }
    const { rows } = await db.auth.query<{ password_hash: string }>(
      'select password_hash from auth.users where id = $1',
      [session.user.id],
    )
    if (!(await verifyPassword(rows[0]?.password_hash ?? null, current))) {
      await recordFailure(db.auth, email, request.ip)
      throw new ValidationFailed({ current_password: ['La password attuale non è corretta.'] })
    }
    await clearFailures(db.auth, email)
    const hash = await hashPassword(next)
    const client = await db.auth.connect()
    try {
      await client.query('begin')
      await client.query('update auth.users set password_hash = $2 where id = $1', [
        session.user.id,
        hash,
      ])
      // Whoever knew the old password is signed out everywhere else.
      await client.query('delete from auth.sessions where user_id = $1 and id <> $2', [
        session.user.id,
        session.id,
      ])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    return reply.code(204).send()
  })

  app.get('/api/me/sessions', async (request) => {
    const session = requireSession(request)
    const { rows } = await db.auth.query<{
      id: string
      user_agent: string | null
      created_at: Date
      last_used_at: Date
      current: boolean
    }>(
      `select public_id as id, user_agent, created_at, last_used_at, id = $2 as current
         from auth.sessions
        where user_id = $1 and expires_at > now()
        order by id = $2 desc, last_used_at desc, created_at desc, public_id`,
      [session.user.id, session.id],
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        user_agent: row.user_agent,
        created_at: row.created_at.toISOString(),
        last_used_at: row.last_used_at.toISOString(),
        current: row.current,
      })),
    }
  })

  // Every session but this one: "esci dagli altri dispositivi".
  app.delete('/api/me/sessions', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await db.auth.query('delete from auth.sessions where user_id = $1 and id <> $2', [
      session.user.id,
      session.id,
    ])
    return reply.code(204).send()
  })

  app.delete<{ Params: { session: string } }>(
    '/api/me/sessions/:session',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      if (!UUID.test(request.params.session)) throw notFound()
      const { rows } = await db.auth.query<{ current: boolean }>(
        `select id = $3 as current from auth.sessions
          where user_id = $1 and public_id = $2 and expires_at > now()`,
        [session.user.id, request.params.session, session.id],
      )
      const row = rows[0]
      if (!row) throw notFound()
      if (row.current) throw new ApiError(409, CURRENT_SESSION, 'current_session')
      await db.auth.query('delete from auth.sessions where user_id = $1 and public_id = $2', [
        session.user.id,
        request.params.session,
      ])
      return reply.code(204).send()
    },
  )
}

const CURRENT_SESSION = "Questo è l'accesso che stai usando: per chiuderlo esci."

function asObject(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

async function loadMe(db: Db, user: SessionUser) {
  const companies = await withIdentity(db.app, { userId: user.id }, async (client) => {
    const { rows } = await client.query<{
      slug: string
      name: string
      role: string
      permissions: string[]
      has_logo: boolean
    }>(
      `select c.slug, c.name, r.name as role,
                c.id in (select app.my_companies_with_logo()) as has_logo,
                coalesce(array_agg(rp.permission order by rp.permission)
                  filter (where rp.permission is not null), '{}') as permissions
         from public.memberships m
         join public.companies c on c.id = m.company_id
         join public.roles r on r.id = m.role_id
         left join public.role_permissions rp on rp.role_id = r.id
         where m.user_id = app.current_user_id() and m.disabled_at is null
         group by c.id, c.slug, c.name, r.name
         order by c.name`,
    )
    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      role: row.role,
      has_logo: row.has_logo,
      // Only permissions the contract knows: the frontend's types are generated from it.
      permissions: row.permissions.filter(isPermission),
    }))
  })
  return { id: user.id, name: user.name, email: user.email, companies }
}
