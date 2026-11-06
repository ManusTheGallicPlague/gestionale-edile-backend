import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { issueCsrfToken, preSessionBinding, sessionBinding } from '../auth/csrf.js'
import { randomToken } from '../auth/crypto.js'
import { clearFailures, recordFailure, secondsUntilAllowed } from '../auth/login-limits.js'
import { verifyPassword } from '../auth/password.js'
import { createSession, destroySession } from '../auth/sessions.js'
import { ApiError, ValidationFailed, messages, type FieldErrors } from '../http/errors.js'
import {
  COOKIES,
  checkCsrf,
  cookieOptions,
  requireSession,
  setCsrfCookie,
} from '../http/request-context.js'

const WRONG_CREDENTIALS = 'Email o password non corretti.'

function readLogin(body: unknown): { email: string; password: string } {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const errors: FieldErrors = {}
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : ''
  const password = typeof raw.password === 'string' ? raw.password : ''
  if (!email) errors.email = ["Inserisci l'email."]
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    errors.email = ["L'indirizzo email non sembra valido."]
  }
  if (!password) errors.password = ['Inserisci la password.']
  else if (password.length > 200) errors.password = ['Al massimo 200 caratteri.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { email, password }
}

/**
 * Opens a fresh session for the user, closing the one this browser had, if any, and
 * renews the CSRF token. Used at sign-in and when an invitation is accepted.
 */
export async function startSession(
  config: Config,
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  if (request.session) await destroySession(db.auth, request.session.id)
  const session = await createSession(db.auth, userId)
  reply.setCookie(COOKIES.session, session.token, {
    ...cookieOptions(config),
    httpOnly: true,
    expires: session.expiresAt,
  })
  reply.clearCookie(COOKIES.preSession, cookieOptions(config))
  setCsrfCookie(config, reply, issueCsrfToken(config.csrfSecret, sessionBinding(session.id)))
}

export function authRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get('/api/auth/csrf', async (request, reply) => {
    let binding: string
    if (request.session) {
      binding = sessionBinding(request.session.id)
    } else {
      // Before sign-in the token binds to an HttpOnly pre-session cookie.
      let pre = request.cookies[COOKIES.preSession]
      if (!pre) {
        pre = randomToken()
        reply.setCookie(COOKIES.preSession, pre, {
          ...cookieOptions(config),
          httpOnly: true,
          maxAge: 24 * 60 * 60,
        })
      }
      binding = preSessionBinding(pre)
    }
    setCsrfCookie(config, reply, issueCsrfToken(config.csrfSecret, binding))
    return reply.code(204).send()
  })

  app.post('/api/auth/login', async (request, reply) => {
    checkCsrf(config, request)
    const { email, password } = readLogin(request.body)

    const wait = await secondsUntilAllowed(db.auth, config.loginLimits, email, request.ip)
    if (wait !== null) {
      throw new ApiError(429, messages.tooManyAttempts, undefined, { 'Retry-After': String(wait) })
    }

    const { rows } = await db.auth.query<{ id: string; password_hash: string; active: boolean }>(
      'select id, password_hash, active from auth.users where email = $1',
      [email],
    )
    const user = rows[0]
    const passwordOk = await verifyPassword(user?.password_hash ?? null, password)
    // Same answer for an unknown email, a wrong password or a disabled account.
    if (!user || !passwordOk || !user.active) {
      await recordFailure(db.auth, email, request.ip)
      throw new ValidationFailed({ email: [WRONG_CREDENTIALS] }, 'Accesso non riuscito.')
    }

    await clearFailures(db.auth, email)
    await startSession(config, db, request, reply, user.id)
    return reply.code(204).send()
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await destroySession(db.auth, session.id)
    reply.clearCookie(COOKIES.session, cookieOptions(config))
    reply.clearCookie(COOKIES.csrf, cookieOptions(config))
    return reply.code(204).send()
  })
}
