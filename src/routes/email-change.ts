import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { randomToken, sha256 } from '../auth/crypto.js'
import { clearFailures, recordFailure, secondsUntilAllowed } from '../auth/login-limits.js'
import { verifyPassword } from '../auth/password.js'
import { ApiError, ValidationFailed, messages, type FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import type { Mailer } from '../mail/mailer.js'

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/
const EMAIL = /^[^\s@]+@[^\s@]+$/
const LIFETIME = '24 hours'
/** Requests per account per hour beyond which no further request is accepted. */
const MAX_PER_HOUR = 3
const INVALID_LINK = "Il link non è valido o è scaduto: chiedi di nuovo il cambio dell'email."
const IN_USE = 'Questa email è già usata da un altro account.'

function asObject(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

export function emailChangeRoutes(
  app: FastifyInstance,
  config: Config,
  db: Db,
  mailer: Mailer,
): void {
  app.post('/api/me/email', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const raw = asObject(request.body)
    const next = typeof raw.new_email === 'string' ? raw.new_email.trim().toLowerCase() : ''
    const current = typeof raw.current_password === 'string' ? raw.current_password : ''
    const errors: FieldErrors = {}
    if (!next || next.length > 254 || next.length < 3 || !EMAIL.test(next)) {
      errors.new_email = ["L'indirizzo email non sembra valido."]
    }
    if (!current) errors.current_password = ['Inserisci la password attuale.']
    else if (current.length > 200) errors.current_password = ['Al massimo 200 caratteri.']
    if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)

    const { email } = session.user
    const wait = await secondsUntilAllowed(db.auth, config.loginLimits, email, request.ip)
    if (wait !== null) {
      throw new ApiError(429, messages.tooManyAttempts, undefined, { 'Retry-After': String(wait) })
    }
    const { rows } = await db.auth.query<{
      password_hash: string
      name: string
      email: string
      recent: number
    }>(
      `select password_hash, name, email,
         (select count(*)::int from auth.email_changes c
          where c.user_id = u.id and c.created_at > now() - interval '1 hour') as recent
       from auth.users u where id = $1`,
      [session.user.id],
    )
    const user = rows[0]
    if (!user || !(await verifyPassword(user.password_hash, current))) {
      await recordFailure(db.auth, email, request.ip)
      throw new ValidationFailed({ current_password: ['La password attuale non è corretta.'] })
    }
    await clearFailures(db.auth, email)
    if (next === user.email) {
      throw new ValidationFailed({ new_email: ["È già l'email del tuo account."] })
    }
    const taken = await db.auth.query('select 1 from auth.users where email = $1', [next])
    if (taken.rowCount) throw new ValidationFailed({ new_email: [IN_USE] })
    if (user.recent >= MAX_PER_HOUR) {
      throw new ApiError(429, messages.tooManyAttempts, undefined, { 'Retry-After': '3600' })
    }

    const token = randomToken()
    const client = await db.auth.connect()
    try {
      await client.query('begin')
      // Only the latest link works: the earlier ones are spent, not deleted, so that they
      // still count towards the hourly limit.
      await client.query(
        'update auth.email_changes set used_at = now() where user_id = $1 and used_at is null',
        [session.user.id],
      )
      await client.query(
        `insert into auth.email_changes (user_id, new_email, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '${LIFETIME}')`,
        [session.user.id, next, sha256(token)],
      )
      // Housekeeping, as for the password resets.
      await client.query(
        "delete from auth.email_changes where created_at < now() - interval '7 days'",
      )
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    await mailer.send({
      to: next,
      subject: "Conferma dell'email",
      text:
        `Ciao ${user.name},\n\n` +
        `per usare questo indirizzo nel gestionale apri questo link entro 24 ore:\n` +
        `${config.appUrl}/conferma-email/${token}\n\n` +
        `Se non hai chiesto tu il cambio, ignora questo messaggio.\n`,
    })
    await mailer.send({
      to: user.email,
      subject: "Richiesta di cambio dell'email",
      text:
        `Ciao ${user.name},\n\n` +
        `è stato chiesto di cambiare l'email del tuo account in ${next}. ` +
        `Il cambio avviene solo quando si apre il link inviato al nuovo indirizzo.\n\n` +
        `Se non sei stato tu, cambia subito la password: chiude gli altri accessi.\n`,
    })
    return reply.code(204).send()
  })

  app.post<{ Params: { token: string } }>(
    '/api/auth/email-change/:token',
    async (request, reply) => {
      checkCsrf(config, request)
      if (!TOKEN.test(request.params.token)) throw new ApiError(404, INVALID_LINK)
      const client = await db.auth.connect()
      try {
        await client.query('begin')
        // Marks the token used in the same statement that checks it: it works once.
        const { rows } = await client.query<{ user_id: string; new_email: string }>(
          `update auth.email_changes c set used_at = now()
           from auth.users u
           where c.token_hash = $1 and c.used_at is null and c.expires_at > now()
             and u.id = c.user_id and u.active
           returning c.user_id, c.new_email`,
          [sha256(request.params.token)],
        )
        const found = rows[0]
        if (!found) throw new ApiError(404, INVALID_LINK)
        await client.query('savepoint change')
        try {
          await client.query('update auth.users set email = $2 where id = $1', [
            found.user_id,
            found.new_email,
          ])
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error
          // Taken by another account in the meantime: the link stays usable for nothing.
          await client.query('rollback to savepoint change')
          await client.query('commit')
          throw new ApiError(409, IN_USE, 'email_in_use')
        }
        await client.query(
          'delete from auth.email_changes where user_id = $1 and used_at is null',
          [found.user_id],
        )
        await client.query('commit')
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
