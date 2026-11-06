import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import type { Config } from '../config.js'
import { clearFailures, recordFailure, secondsUntilAllowed } from '../auth/login-limits.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import type { SessionUser } from '../auth/sessions.js'
import { ApiError, ValidationFailed, messages, type FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { MIN_PASSWORD_LENGTH } from './invitations.js'
import { isPermission } from '../permissions.js'

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
}

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
  return { id: user.id, name: user.name, email: user.email, companies }
}
