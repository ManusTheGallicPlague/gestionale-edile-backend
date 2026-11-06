import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { preSessionBinding, sessionBinding, verifyCsrfToken } from '../auth/csrf.js'
import type { Session } from '../auth/sessions.js'
import { csrfInvalid, unauthorized } from './errors.js'

export const COOKIES = {
  session: 'session',
  csrf: 'XSRF-TOKEN',
  preSession: 'pre_session',
} as const
export const CSRF_HEADER = 'x-xsrf-token'

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null
  }
}

export function requireSession(request: FastifyRequest): Session {
  if (!request.session) throw unauthorized()
  return request.session
}

/** What the CSRF token of this request must be bound to, if anything. */
export function csrfBinding(request: FastifyRequest): string | null {
  if (request.session) return sessionBinding(request.session.id)
  const pre = request.cookies[COOKIES.preSession]
  return pre ? preSessionBinding(pre) : null
}

/**
 * Checks the CSRF token of a request that changes data: the header must equal the cookie
 * (double submit) and carry a valid signature for this session or pre-session.
 */
export function checkCsrf(config: Config, request: FastifyRequest): void {
  const header = request.headers[CSRF_HEADER]
  const cookie = request.cookies[COOKIES.csrf]
  const binding = csrfBinding(request)
  if (typeof header !== 'string' || !cookie || header !== cookie || !binding) throw csrfInvalid()
  if (!verifyCsrfToken(config.csrfSecret, binding, header)) throw csrfInvalid()
}

export function cookieOptions(config: Config) {
  return {
    path: '/',
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
  }
}

export function setCsrfCookie(config: Config, reply: FastifyReply, token: string): void {
  // Readable by the page on purpose: the frontend copies it into the X-XSRF-TOKEN header.
  reply.setCookie(COOKIES.csrf, token, { ...cookieOptions(config), httpOnly: false })
}
