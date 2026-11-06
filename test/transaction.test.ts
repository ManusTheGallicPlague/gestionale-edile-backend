import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { withIdentity } from '../src/db.js'
import { Browser, Fixtures, startApp, unique, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures
let app: FastifyInstance
let identity: { userId: string; companyId: string }

// A response sent inside withIdentity() left before the commit: the next request could
// still see the old data (the flaky invitation test). These routes reproduce both shapes.
beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
  const { company, user } = await fx.companyWithUser(['clients.view'])
  identity = { userId: user.id, companyId: company.id }
  app = buildApp(ctx.config, ctx.db, { logger: false })
  const insert = (client: import('pg').PoolClient, name: string) =>
    client.query(
      "insert into public.clients (company_id, kind, name) values (app.current_company_id(), 'person', $1)",
      [name],
    )
  app.post<{ Querystring: { name: string } }>('/test/send-inside', async (request, reply) =>
    withIdentity(ctx.db.app, identity, async (client) => {
      await insert(client, request.query.name)
      return reply.code(201).send({ ok: true })
    }),
  )
  app.post<{ Querystring: { name: string } }>('/test/send-after', async (request, reply) => {
    await withIdentity(ctx.db.app, identity, (client) => insert(client, request.query.name))
    return reply.code(201).send({ ok: true })
  })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await ctx.close()
})

async function saved(name: string) {
  const { rowCount } = await ctx.owner.query('select 1 from public.clients where name = $1', [name])
  return rowCount
}

describe('responses and transactions', () => {
  it('refuses a response sent before the commit and rolls the transaction back', async () => {
    const name = `dentro-${unique()}`
    const res = await new Browser(app).request('POST', `/test/send-inside?name=${name}`)
    expect(res.statusCode).toBe(500)
    expect(await saved(name)).toBe(0)
  })

  it('a response sent after the commit finds the data already saved', async () => {
    const name = `dopo-${unique()}`
    const res = await new Browser(app).request('POST', `/test/send-after?name=${name}`)
    expect(res.statusCode).toBe(201)
    expect(await saved(name)).toBe(1)
  })
})
