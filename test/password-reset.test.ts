import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function guest() {
  const browser = new Browser(ctx.app)
  await browser.request('GET', '/api/auth/csrf')
  return browser
}

function tokenFor(email: string): string {
  const message = [...ctx.mailer.sent].reverse().find((m) => m.to === email)
  const match = /\/password-dimenticata\/([A-Za-z0-9_-]+)/.exec(message?.text ?? '')
  if (!match?.[1]) throw new Error(`no reset email for ${email}`)
  return match[1]
}

describe('forgotten password', () => {
  it('sends a one-time link that sets a new password and closes every session', async () => {
    const user = await fx.user()
    const signedIn = new Browser(ctx.app)
    await signedIn.signIn(user.email)

    const visitor = await guest()
    const asked = await visitor.call('POST', '/api/auth/password-reset', {
      body: { email: ` ${user.email.toUpperCase()} ` },
    })
    expect(asked.statusCode).toBe(204)
    const token = tokenFor(user.email)
    const message = ctx.mailer.sent.find((m) => m.text.includes(token))
    expect(message?.text).toContain(`https://gestionale.example.test/password-dimenticata/${token}`)

    const short = await visitor.call('POST', `/api/auth/password-reset/${token}`, {
      body: { new_password: 'corta' },
    })
    expect(short.statusCode).toBe(422)
    const done = await visitor.call('POST', `/api/auth/password-reset/${token}`, {
      body: { new_password: 'password-ritrovata' },
    })
    expect(done.statusCode).toBe(204)
    expect((await signedIn.call('GET', '/api/me')).statusCode).toBe(401)
    await new Browser(ctx.app).signIn(user.email, 'password-ritrovata')
    const old = await (
      await guest()
    ).call('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } })
    expect(old.statusCode).toBe(422)

    const again = await visitor.call('POST', `/api/auth/password-reset/${token}`, {
      body: { new_password: 'altra-password-ancora' },
    })
    expect(again.statusCode).toBe(404)
  })

  it('answers the same for unknown or disabled accounts, and sends nothing', async () => {
    const disabled = await fx.user({ active: false })
    const before = ctx.mailer.sent.length
    const visitor = await guest()
    for (const email of ['nessuno@example.test', disabled.email]) {
      const res = await visitor.call('POST', '/api/auth/password-reset', { body: { email } })
      expect(res.statusCode).toBe(204)
    }
    expect(ctx.mailer.sent.length).toBe(before)
    const bad = await visitor.call('POST', '/api/auth/password-reset', { body: { email: 'x' } })
    expect(bad.statusCode).toBe(422)
  })

  it('a new link kills the others; at most three emails an hour', async () => {
    const user = await fx.user()
    const visitor = await guest()
    const ask = () =>
      visitor.call('POST', '/api/auth/password-reset', { body: { email: user.email } })
    await ask()
    const first = tokenFor(user.email)
    await ask()
    const second = tokenFor(user.email)
    expect(second).not.toBe(first)
    await ask()
    await ask()
    expect(ctx.mailer.sent.filter((m) => m.to === user.email)).toHaveLength(3)

    const used = await visitor.call('POST', `/api/auth/password-reset/${second}`, {
      body: { new_password: 'password-ritrovata' },
    })
    expect(used.statusCode).toBe(204)
    const stale = await visitor.call('POST', `/api/auth/password-reset/${first}`, {
      body: { new_password: 'password-di-nuovo' },
    })
    expect(stale.statusCode).toBe(404)
  })

  it('expired links and missing CSRF tokens are refused', async () => {
    const user = await fx.user()
    const visitor = await guest()
    await visitor.call('POST', '/api/auth/password-reset', { body: { email: user.email } })
    const token = tokenFor(user.email)
    await ctx.owner.query(
      "update auth.password_resets set expires_at = now() - interval '1 minute' where user_id = $1",
      [user.id],
    )
    const late = await visitor.call('POST', `/api/auth/password-reset/${token}`, {
      body: { new_password: 'password-ritrovata' },
    })
    expect(late.statusCode).toBe(404)
    const noCsrf = await visitor.call('POST', '/api/auth/password-reset', {
      body: { email: user.email },
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(
      (
        await visitor.call('POST', '/api/auth/password-reset/corto', {
          body: { new_password: 'password-ritrovata' },
        })
      ).statusCode,
    ).toBe(404)
  })
})
