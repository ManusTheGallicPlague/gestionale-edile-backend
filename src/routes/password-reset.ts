import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { randomToken, sha256 } from '../auth/crypto.js'
import { clearFailures } from '../auth/login-limits.js'
import { hashPassword } from '../auth/password.js'
import { ApiError, ValidationFailed } from '../http/errors.js'
import { checkCsrf } from '../http/request-context.js'
import type { Mailer } from '../mail/mailer.js'
import { MIN_PASSWORD_LENGTH } from './invitations.js'

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/
const LIFETIME = '1 hour'
/** Requests per account per hour beyond which no further email is sent. */
const MAX_PER_HOUR = 3
const INVALID_LINK = 'Il link non è valido o è scaduto: chiedi di nuovo il cambio della password.'

function asObject(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

export function passwordResetRoutes(
  app: FastifyInstance,
  config: Config,
  db: Db,
  mailer: Mailer,
): void {
  app.post('/api/auth/password-reset', async (request, reply) => {
    checkCsrf(config, request)
    const raw = asObject(request.body)
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : ''
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new ValidationFailed({ email: ["L'indirizzo email non sembra valido."] })
    }

    // Same answer whether the account exists or not: nothing is revealed.
    const { rows } = await db.auth.query<{ id: string; name: string; recent: number }>(
      `select u.id, u.name,
         (select count(*)::int from auth.password_resets r
          where r.user_id = u.id and r.created_at > now() - interval '1 hour') as recent
       from auth.users u where u.email = $1 and u.active`,
      [email],
    )
    const user = rows[0]
    if (user && user.recent < MAX_PER_HOUR) {
      const token = randomToken()
      await db.auth.query(
        `insert into auth.password_resets (user_id, token_hash, expires_at)
         values ($1, $2, now() + interval '${LIFETIME}')`,
        [user.id, sha256(token)],
      )
      // Housekeeping, as for the sign-in failures.
      await db.auth.query(
        "delete from auth.password_resets where created_at < now() - interval '1 day'",
      )
      await mailer.send({
        to: email,
        subject: 'Cambio della password',
        text:
          `Ciao ${user.name},\n\n` +
          `per scegliere una nuova password apri questo link entro un'ora:\n` +
          `${config.appUrl}/password-dimenticata/${token}\n\n` +
          `Se non hai chiesto tu il cambio, ignora questo messaggio: la password resta quella di prima.\n`,
      })
    }
    return reply.code(204).send()
  })

  app.post<{ Params: { token: string } }>(
    '/api/auth/password-reset/:token',
    async (request, reply) => {
      checkCsrf(config, request)
      const raw = asObject(request.body)
      const password = typeof raw.new_password === 'string' ? raw.new_password : ''
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new ValidationFailed({ new_password: [`Almeno ${MIN_PASSWORD_LENGTH} caratteri.`] })
      }
      if (password.length > 200) {
        throw new ValidationFailed({ new_password: ['Al massimo 200 caratteri.'] })
      }
      if (!TOKEN.test(request.params.token)) throw new ApiError(404, INVALID_LINK)
      const hash = await hashPassword(password)

      const client = await db.auth.connect()
      try {
        await client.query('begin')
        // Marks the token used in the same statement that checks it: it works once.
        const { rows } = await client.query<{ user_id: string; email: string }>(
          `update auth.password_resets r set used_at = now()
           from auth.users u
           where r.token_hash = $1 and r.used_at is null and r.expires_at > now()
             and u.id = r.user_id and u.active
           returning r.user_id, u.email`,
          [sha256(request.params.token)],
        )
        const found = rows[0]
        if (!found) throw new ApiError(404, INVALID_LINK)
        await client.query('update auth.users set password_hash = $2 where id = $1', [
          found.user_id,
          hash,
        ])
        // Every session and every other link of the account stops working.
        await client.query('delete from auth.sessions where user_id = $1', [found.user_id])
        await client.query(
          'delete from auth.password_resets where user_id = $1 and used_at is null',
          [found.user_id],
        )
        await client.query('commit')
        await clearFailures(db.auth, found.email)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      } finally {
        client.release()
      }
      return reply.code(204).send()
    },
  )
}
