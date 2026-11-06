import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { messages } from '../http/errors.js'

/** How long the health check waits for the database before calling it unreachable. */
const TIMEOUT_MS = 2000

async function reachable(pool: Db['app']): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), TIMEOUT_MS)
  })
  const probe = pool.query('select 1').then(
    () => true,
    () => false,
  )
  try {
    return await Promise.race([probe, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * For the load balancer, the container orchestrator and uptime monitors: no session, no
 * company data. 200 when the API reaches the database with both its roles, 503 otherwise.
 */
export function healthRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/health', async (_request, reply) => {
    const [appOk, authOk] = await Promise.all([reachable(db.app), reachable(db.auth)])
    if (appOk && authOk) return { status: 'ok' }
    return reply
      .code(503)
      .send({ message: messages.databaseUnavailable, code: 'database_unavailable' })
  })
}
