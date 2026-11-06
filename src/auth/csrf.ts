import { hmac, randomToken, safeEqual } from './crypto.js'

/**
 * CSRF tokens are "signed double submit" bound to the session:
 *
 *   token = nonce + "." + HMAC(secret, binding + "|" + nonce)
 *
 * The binding is the session id, or before sign-in the id in the HttpOnly pre-session cookie.
 * A token forged by a sibling subdomain, or kept from another session, does not verify:
 * header and cookie matching is not enough on its own.
 */
export function issueCsrfToken(secret: string, binding: string): string {
  const nonce = randomToken(18)
  return `${nonce}.${hmac(secret, `${binding}|${nonce}`)}`
}

export function verifyCsrfToken(secret: string, binding: string, token: string): boolean {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const nonce = token.slice(0, dot)
  return safeEqual(token.slice(dot + 1), hmac(secret, `${binding}|${nonce}`))
}

export const sessionBinding = (sessionId: string) => `s:${sessionId}`
export const preSessionBinding = (preSessionId: string) => `p:${preSessionId}`
