import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { Browser, startApp, type TestContext } from './helpers.js'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startApp()
})
afterAll(() => ctx.close())

describe('health', () => {
  it('answers ok without a session when the database is reachable', async () => {
    const res = await new Browser(ctx.app).call('GET', '/api/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('answers 503 when the database is not reachable', async () => {
    // Nothing listens on port 1: the connection is refused at once.
    const down = 'postgres://nessuno:nessuna@127.0.0.1:1/nessuno'
    const db = createDb({ app: down, auth: ctx.config.databaseUrlAuth })
    const app = buildApp(ctx.config, db, { logger: false })
    try {
      await app.ready()
      const res = await new Browser(app).call('GET', '/api/health')
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'database_unavailable' })
    } finally {
      await app.close()
      await db.close()
    }
  })
})
