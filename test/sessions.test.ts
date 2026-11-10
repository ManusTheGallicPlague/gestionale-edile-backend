import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

interface MySession {
  id: string
  user_agent: string | null
  created_at: string
  last_used_at: string
  current: boolean
}

async function signInWith(browser: Browser, email: string, userAgent: string) {
  await browser.request('GET', '/api/auth/csrf')
  const res = await browser.call('POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
    headers: { 'user-agent': userAgent },
  })
  expect(res.statusCode).toBe(204)
}

async function sessionsOf(browser: Browser) {
  const res = await browser.call('GET', '/api/me/sessions')
  expect(res.statusCode).toBe(200)
  return res.json<{ data: MySession[] }>().data
}

describe('own sessions', () => {
  it('lists the open sessions of the user, the current one first, never the token', async () => {
    const user = await fx.user()
    const other = await fx.user()
    const laptop = new Browser(ctx.app)
    await signInWith(laptop, user.email, 'Browser del portatile')
    const phone = new Browser(ctx.app)
    await signInWith(phone, user.email, `Telefono ${'x'.repeat(400)}`)
    await new Browser(ctx.app).signIn(other.email)

    const list = await sessionsOf(laptop)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ current: true, user_agent: 'Browser del portatile' })
    expect(list[1]?.current).toBe(false)
    expect(list[1]?.user_agent).toHaveLength(300)
    const fromPhone = await sessionsOf(phone)
    expect(fromPhone[0]?.id).toBe(list[1]?.id)
    expect(fromPhone[0]?.current).toBe(true)

    // The public id is not the hash of the cookie, which binds the CSRF token.
    const { rows } = await ctx.owner.query<{ id: string }>(
      'select id from auth.sessions where user_id = $1',
      [user.id],
    )
    const body = JSON.stringify(list)
    for (const row of rows) expect(body).not.toContain(row.id)

    expect((await new Browser(ctx.app).call('GET', '/api/me/sessions')).statusCode).toBe(401)
  })

  it('leaves out expired sessions and tracks the last use', async () => {
    const user = await fx.user()
    const here = new Browser(ctx.app)
    await here.signIn(user.email)
    const old = new Browser(ctx.app)
    await old.signIn(user.email)
    await ctx.owner.query(
      `update auth.sessions set last_used_at = now() - interval '1 hour'
        where user_id = $1`,
      [user.id],
    )
    const [, second] = await sessionsOf(here)
    const expired = await ctx.owner.query(
      `update auth.sessions set expires_at = now() - interval '1 minute'
        where user_id = $1 and public_id = $2`,
      [user.id, second?.id],
    )
    expect(expired.rowCount).toBe(1)
    const list = await sessionsOf(here)
    expect(list).toHaveLength(1)
    // An hour old: this request moved it to now.
    expect(Date.now() - Date.parse(list[0]?.last_used_at ?? '')).toBeLessThan(60_000)
    const gone = await here.call('DELETE', `/api/me/sessions/${second?.id}`)
    expect(gone.statusCode).toBe(404)
  })

  it('closes a session from another device, not the current one nor someone else’s', async () => {
    const user = await fx.user()
    const other = await fx.user()
    const here = new Browser(ctx.app)
    await here.signIn(user.email)
    const phone = new Browser(ctx.app)
    await phone.signIn(user.email)
    const stranger = new Browser(ctx.app)
    await stranger.signIn(other.email)
    const [current, phoneSession] = await sessionsOf(here)
    const [strangerSession] = await sessionsOf(stranger)

    const self = await here.call('DELETE', `/api/me/sessions/${current?.id}`)
    expect(self.statusCode).toBe(409)
    expect(self.json<{ code: string }>().code).toBe('current_session')

    const foreign = await here.call('DELETE', `/api/me/sessions/${strangerSession?.id}`)
    expect(foreign.statusCode).toBe(404)
    expect((await stranger.call('GET', '/api/me')).statusCode).toBe(200)
    expect((await here.call('DELETE', '/api/me/sessions/non-un-uuid')).statusCode).toBe(404)

    const noCsrf = await here.call('DELETE', `/api/me/sessions/${phoneSession?.id}`, {
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect((await phone.call('GET', '/api/me')).statusCode).toBe(200)

    const closed = await here.call('DELETE', `/api/me/sessions/${phoneSession?.id}`)
    expect(closed.statusCode).toBe(204)
    expect((await phone.call('GET', '/api/me')).statusCode).toBe(401)
    expect((await here.call('GET', '/api/me')).statusCode).toBe(200)
    const again = await here.call('DELETE', `/api/me/sessions/${phoneSession?.id}`)
    expect(again.statusCode).toBe(404)
  })

  it('closes every other session of the user and only those', async () => {
    const user = await fx.user()
    const other = await fx.user()
    const here = new Browser(ctx.app)
    await here.signIn(user.email)
    const phone = new Browser(ctx.app)
    await phone.signIn(user.email)
    const tablet = new Browser(ctx.app)
    await tablet.signIn(user.email)
    const stranger = new Browser(ctx.app)
    await stranger.signIn(other.email)

    expect((await here.call('DELETE', '/api/me/sessions', { csrf: false })).statusCode).toBe(403)
    expect((await here.call('DELETE', '/api/me/sessions')).statusCode).toBe(204)
    expect((await phone.call('GET', '/api/me')).statusCode).toBe(401)
    expect((await tablet.call('GET', '/api/me')).statusCode).toBe(401)
    expect((await stranger.call('GET', '/api/me')).statusCode).toBe(200)
    const list = await sessionsOf(here)
    expect(list.map((s) => s.current)).toEqual([true])
    expect((await new Browser(ctx.app).call('DELETE', '/api/me/sessions')).statusCode).toBe(401)
  })
})
