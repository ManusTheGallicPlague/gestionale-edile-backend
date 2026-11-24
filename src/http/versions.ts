import type { PoolClient } from 'pg'
import { ApiError } from './errors.js'

/**
 * The ETag of a record is its version in quotes ("7"), a strong ETag. If-Match takes it as
 * it is or weak (W/"7"): a proxy that compresses responses, like nginx with gzip, turns the
 * ETag into a weak one, and the frontend sends back what it got. Our versions are numbers
 * that change on every write, so the weak form names the same version.
 */
export const IF_MATCH = /^(?:W\/)?"(\d{1,9})"$/

/**
 * 412 comes before 422: when the record exists and its version is not the one in If-Match,
 * the change is refused before the body is validated, so who edits a stale record is told
 * to reload it, not to fix fields that may have changed meanwhile. `where` picks the record
 * as the route does (its id and, for a child record, its parent); if nothing matches the
 * route goes on and answers 404 as before. The write keeps its own version check, which
 * settles a change that lands in between.
 */
export async function refuseStale(
  client: PoolClient,
  table: string,
  where: Record<string, unknown>,
  version: number,
  message: string,
): Promise<void> {
  const columns = Object.keys(where)
  const { rows } = await client.query<{ version: number }>(
    `select version from ${table} where ${columns.map((c, i) => `${c} = $${i + 1}`).join(' and ')}`,
    columns.map((c) => where[c]),
  )
  const current = rows[0]
  if (current && current.version !== version) throw new ApiError(412, message, 'stale_record')
}
