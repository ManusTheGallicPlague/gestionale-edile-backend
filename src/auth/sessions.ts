import type pg from 'pg'
import { randomToken, sha256 } from './crypto.js'

const LIFETIME_MS = 14 * 24 * 60 * 60 * 1000 // 14 days of inactivity
const RENEW_BELOW_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionUser {
  id: string
  name: string
  email: string
}

export interface Session {
  /** SHA-256 of the cookie token: what the database stores and the CSRF token binds to. */
  id: string
  user: SessionUser
  expiresAt: Date
}

export async function createSession(
  auth: pg.Pool,
  userId: string,
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken()
  const id = sha256(token)
  const expiresAt = new Date(Date.now() + LIFETIME_MS)
  await auth.query('insert into auth.sessions (id, user_id, expires_at) values ($1, $2, $3)', [
    id,
    userId,
    expiresAt,
  ])
  return { token, id, expiresAt }
}

/** Returns the live session for a cookie token, renewing it when it is getting old. */
export async function findSession(auth: pg.Pool, token: string): Promise<Session | null> {
  const id = sha256(token)
  const { rows } = await auth.query<{
    expires_at: Date
    user_id: string
    name: string
    email: string
    active: boolean
  }>(
    `select s.expires_at, u.id as user_id, u.name, u.email, u.active
     from auth.sessions s join auth.users u on u.id = s.user_id
     where s.id = $1`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  if (row.expires_at.getTime() <= Date.now() || !row.active) {
    await auth.query('delete from auth.sessions where id = $1', [id])
    return null
  }
  let expiresAt = row.expires_at
  if (expiresAt.getTime() - Date.now() < RENEW_BELOW_MS) {
    expiresAt = new Date(Date.now() + LIFETIME_MS)
    await auth.query('update auth.sessions set expires_at = $2 where id = $1', [id, expiresAt])
  }
  return { id, user: { id: row.user_id, name: row.name, email: row.email }, expiresAt }
}

export async function destroySession(auth: pg.Pool, id: string): Promise<void> {
  await auth.query('delete from auth.sessions where id = $1', [id])
}
