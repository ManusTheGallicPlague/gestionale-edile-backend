import type pg from 'pg'
import type { LoginLimits } from '../config.js'
import { ApiError, messages } from '../http/errors.js'

/**
 * Sign-in failures are counted in Postgres, per email and per IP, so the limit holds
 * across restarts and across several API processes.
 * Returns the seconds to wait, or null when another attempt is allowed.
 */
export async function secondsUntilAllowed(
  auth: pg.Pool,
  limits: LoginLimits,
  email: string,
  ip: string,
): Promise<number | null> {
  const { rows } = await auth.query<{ by_email: number; by_ip: number; oldest: Date | null }>(
    `with recent as (
       select email, ip, failed_at from auth.login_failures
       where failed_at > now() - make_interval(secs => $3)
         and (email = $1 or ip = $2)
     )
     select
       count(*) filter (where email = $1)::int as by_email,
       count(*) filter (where ip = $2)::int as by_ip,
       min(failed_at) as oldest
     from recent`,
    [email, ip, limits.windowSeconds],
  )
  const row = rows[0]
  if (!row) return null
  const blocked = row.by_email >= limits.maxFailuresPerEmail || row.by_ip >= limits.maxFailuresPerIp
  if (!blocked || !row.oldest) return null
  const elapsed = (Date.now() - row.oldest.getTime()) / 1000
  return Math.max(1, Math.ceil(limits.windowSeconds - elapsed))
}

export async function recordFailure(auth: pg.Pool, email: string, ip: string): Promise<void> {
  await auth.query('insert into auth.login_failures (email, ip) values ($1, $2)', [email, ip])
  // Housekeeping: keeps the table small without a scheduled job.
  await auth.query("delete from auth.login_failures where failed_at < now() - interval '1 day'")
}

export async function clearFailures(auth: pg.Pool, email: string): Promise<void> {
  await auth.query('delete from auth.login_failures where email = $1', [email])
}

/** What is counted per IP when there is no account to count it against. */
export type IpAttempt = 'password_reset_request' | 'link_failure'

/** Seconds to wait before another attempt of this kind from the IP, or null. */
async function secondsUntilIpAllowed(
  auth: pg.Pool,
  kind: IpAttempt,
  ip: string,
  max: number,
  windowSeconds: number,
): Promise<number | null> {
  const { rows } = await auth.query<{ attempts: number; oldest: Date | null }>(
    `select count(*)::int as attempts, min(attempted_at) as oldest
     from auth.ip_attempts
     where kind = $1 and ip = $2 and attempted_at > now() - make_interval(secs => $3)`,
    [kind, ip, windowSeconds],
  )
  const row = rows[0]
  if (!row || row.attempts < max || !row.oldest) return null
  const elapsed = (Date.now() - row.oldest.getTime()) / 1000
  return Math.max(1, Math.ceil(windowSeconds - elapsed))
}

async function recordIpAttempt(auth: pg.Pool, kind: IpAttempt, ip: string): Promise<void> {
  await auth.query('insert into auth.ip_attempts (kind, ip) values ($1, $2)', [kind, ip])
  // Housekeeping, as for the sign-in failures.
  await auth.query("delete from auth.ip_attempts where attempted_at < now() - interval '1 day'")
}

function tooManyRequests(seconds: number): ApiError {
  return new ApiError(429, messages.tooManyRequests, undefined, { 'Retry-After': String(seconds) })
}

/**
 * Counts a password reset request from the IP, or answers 429 when there were too many.
 * Every request counts: the answer is 204 whether the email exists or not.
 */
export async function countResetRequest(
  auth: pg.Pool,
  limits: LoginLimits,
  ip: string,
): Promise<void> {
  const kind = 'password_reset_request'
  const wait = await secondsUntilIpAllowed(
    auth,
    kind,
    ip,
    limits.maxResetRequestsPerIp,
    limits.windowSeconds,
  )
  if (wait !== null) throw tooManyRequests(wait)
  await recordIpAttempt(auth, kind, ip)
}

/**
 * Runs the use of a token from a link (password reset, invitation, email change) under the
 * per-IP limit: every 404, that is a token unknown, used or expired, counts; after too many
 * the answer is 429 before the token is even looked up.
 */
export async function underLinkLimit<T>(
  auth: pg.Pool,
  limits: LoginLimits,
  ip: string,
  use: () => Promise<T>,
): Promise<T> {
  const kind = 'link_failure'
  const wait = await secondsUntilIpAllowed(
    auth,
    kind,
    ip,
    limits.maxLinkFailuresPerIp,
    limits.windowSeconds,
  )
  if (wait !== null) throw tooManyRequests(wait)
  try {
    return await use()
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) await recordIpAttempt(auth, kind, ip)
    throw error
  }
}
