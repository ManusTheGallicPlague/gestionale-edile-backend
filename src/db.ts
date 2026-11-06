import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'

/**
 * Two pools with different privileges:
 *
 * - `app`  → role gestionale_app, subject to Row Level Security. Every company query goes
 *            through `withIdentity()`.
 * - `auth` → role gestionale_auth: users, sessions and sign-in failures, nothing else.
 *            It cannot read company data, and the API role cannot read password hashes.
 */
export interface Db {
  app: pg.Pool
  auth: pg.Pool
  close(): Promise<void>
}

export function createDb(urls: { app: string; auth: string }): Db {
  const app = new pg.Pool({ connectionString: urls.app, max: 10 })
  const auth = new pg.Pool({ connectionString: urls.auth, max: 5 })
  return {
    app,
    auth,
    async close() {
      await Promise.all([app.end(), auth.end()])
    },
  }
}

/**
 * Marks the code running inside a withIdentity() transaction. A response sent from there
 * would reach the client before the commit, so the next request could still see the old
 * data: the onSend hook in app.ts refuses it (500) and the transaction is rolled back.
 */
export const openTransaction = new AsyncLocalStorage<{ responseSent: boolean }>()

export class ResponseBeforeCommit extends Error {
  constructor() {
    super('response sent inside withIdentity(): send it after the transaction commits')
  }
}

export interface Identity {
  userId: string
  companyId?: string
}

/**
 * Runs `fn` in a transaction that declares who is asking and, when known, for which company.
 * The values are transaction-local: they never survive into the next use of the connection.
 * Outside this wrapper the policies see no user, so queries return nothing.
 */
export async function withIdentity<T>(
  pool: pg.Pool,
  identity: Identity,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  const scope = { responseSent: false }
  try {
    await client.query('begin')
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.company_id', $2, true)",
      [identity.userId, identity.companyId ?? ''],
    )
    const result = await openTransaction.run(scope, () => fn(client))
    if (scope.responseSent) throw new ResponseBeforeCommit()
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Switches the declared company inside a transaction opened by withIdentity(). */
export async function declareCompany(client: pg.PoolClient, companyId: string): Promise<void> {
  await client.query("select set_config('app.company_id', $1, true)", [companyId])
}

export function isForeignKeyViolation(error: unknown): error is pg.DatabaseError {
  return error instanceof pg.DatabaseError && error.code === '23503'
}

export function isUniqueViolation(error: unknown): error is pg.DatabaseError {
  return error instanceof pg.DatabaseError && error.code === '23505'
}
