import type pg from 'pg'
import type { LoginLimits } from '../config.js'

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
