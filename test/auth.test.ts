import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('CSRF', () => {
  it('GET /api/auth/csrf sets a readable token and an HttpOnly pre-session', async () => {
    const browser = new Browser(ctx.app)
    const res = await browser.call('GET', '/api/auth/csrf')
    expect(res.statusCode).toBe(204)
    const cookies = res.cookies as { name: string; httpOnly?: boolean; sameSite?: string }[]
    const csrf = cookies.find((c) => c.name === 'XSRF-TOKEN')
    const pre = cookies.find((c) => c.name === 'pre_session')
    expect(csrf?.httpOnly).toBeFalsy()
    expect(csrf?.sameSite).toBe('Lax')
    expect(pre?.httpOnly).toBe(true)
  })

  it('refuses sign-in without the token, with code csrf_invalid', async () => {
    const browser = new Browser(ctx.app)
    const res = await browser.call('POST', '/api/auth/login', {
      body: { email: 'x@example.test', password: 'x' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'csrf_invalid' })
  })

  it('refuses a token taken from another browser', async () => {
    const victim = new Browser(ctx.app)
    await victim.request('GET', '/api/auth/csrf')
    const attacker = new Browser(ctx.app)
    await attacker.request('GET', '/api/auth/csrf')
    // Same header and cookie, but signed for someone else's pre-session
    const stolen = victim.cookies.get('XSRF-TOKEN') ?? ''
    attacker.cookies.set('XSRF-TOKEN', stolen)
    const res = await attacker.call('POST', '/api/auth/login', {
      body: { email: 'x@example.test', password: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a header that differs from the cookie', async () => {
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    const res = await browser.call('POST', '/api/auth/login', {
      body: { email: 'x@example.test', password: 'x' },
      headers: { 'x-xsrf-token': 'altro.valore' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('sign-in', () => {
  it('validates the fields before checking credentials', async () => {
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    const res = await browser.call('POST', '/api/auth/login', { body: { email: 'non-una-email' } })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors).sort()).toEqual(['email', 'password'])
  })

  it('answers the same for unknown email, wrong password and disabled account', async () => {
    const user = await fx.user()
    const disabled = await fx.user({ active: false })
    const bodies = []
    for (const [email, password] of [
      ['nessuno@example.test', PASSWORD],
      [user.email, 'sbagliata'],
      [disabled.email, PASSWORD],
    ] as const) {
      const browser = new Browser(ctx.app)
      await browser.request('GET', '/api/auth/csrf')
      const res = await browser.call('POST', '/api/auth/login', { body: { email, password } })
      expect(res.statusCode).toBe(422)
      bodies.push(res.body)
    }
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      message: 'Accesso non riuscito.',
      errors: { email: ['Email o password non corretti.'] },
    })
  })

  it('opens an HttpOnly session and rotates the CSRF token', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    const before = browser.cookies.get('XSRF-TOKEN')
    const res = await browser.signIn(user.email)
    const session = (res.cookies as { name: string; httpOnly?: boolean }[]).find(
      (c) => c.name === 'session',
    )
    expect(session?.httpOnly).toBe(true)
    expect(browser.cookies.get('XSRF-TOKEN')).not.toBe(before)
    expect(browser.cookies.has('pre_session')).toBe(false)
    const me = await browser.call('GET', '/api/me')
    expect(me.statusCode).toBe(200)
  })

  it('normalizes the email: case and spaces do not matter', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(`  ${user.email.toUpperCase()} `)
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(200)
  })

  it('a pre-sign-in token stops working once the session exists', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    const preToken = browser.cookies.get('XSRF-TOKEN') ?? ''
    await browser.call('POST', '/api/auth/login', {
      body: { email: user.email, password: PASSWORD },
    })
    browser.cookies.set('XSRF-TOKEN', preToken)
    const res = await browser.call('POST', '/api/auth/logout')
    expect(res.statusCode).toBe(403)
  })

  it('signing in again closes the previous session', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const oldSession = browser.cookies.get('session') ?? ''
    await browser.signIn(user.email)
    const stale = new Browser(ctx.app)
    stale.cookies.set('session', oldSession)
    expect((await stale.call('GET', '/api/me')).statusCode).toBe(401)
  })
})

describe('sign-in limits', () => {
  it('after 5 failures on an email answers 429 with Retry-After, even with the right password', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    for (let i = 0; i < 5; i++) {
      const res = await browser.call('POST', '/api/auth/login', {
        body: { email: user.email, password: 'sbagliata' },
      })
      expect(res.statusCode).toBe(422)
    }
    const res = await browser.call('POST', '/api/auth/login', {
      body: { email: user.email, password: PASSWORD },
    })
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    // From another address the same email is still blocked
    const other = new Browser(ctx.app)
    await other.request('GET', '/api/auth/csrf')
    const again = await other.call('POST', '/api/auth/login', {
      body: { email: user.email, password: PASSWORD },
    })
    expect(again.statusCode).toBe(429)
  })

  it('a successful sign-in clears the failures', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    for (let i = 0; i < 4; i++) {
      await browser.request('POST', '/api/auth/login', {
        body: { email: user.email, password: 'sbagliata' },
      })
    }
    await browser.signIn(user.email)
    const fresh = new Browser(ctx.app)
    await fresh.request('GET', '/api/auth/csrf')
    for (let i = 0; i < 4; i++) {
      const res = await fresh.request('POST', '/api/auth/login', {
        body: { email: user.email, password: 'sbagliata' },
      })
      expect(res.statusCode).toBe(422)
    }
  })
})

describe('sign-out', () => {
  it('closes the session on the server', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const session = browser.cookies.get('session') ?? ''
    const res = await browser.call('POST', '/api/auth/logout')
    expect(res.statusCode).toBe(204)
    expect(browser.cookies.has('session')).toBe(false)
    // The old cookie, replayed, is worthless
    const replay = new Browser(ctx.app)
    replay.cookies.set('session', session)
    expect((await replay.call('GET', '/api/me')).statusCode).toBe(401)
  })

  it('without a session answers 401', async () => {
    const browser = new Browser(ctx.app)
    await browser.request('GET', '/api/auth/csrf')
    expect((await browser.call('POST', '/api/auth/logout')).statusCode).toBe(401)
  })
})
