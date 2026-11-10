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
  const match = /\/conferma-email\/([A-Za-z0-9_-]+)/.exec(message?.text ?? '')
  if (!match?.[1]) throw new Error(`no confirmation email for ${email}`)
  return match[1]
}

let counter = 0
function freshEmail() {
  counter += 1
  return `nuova-${Date.now()}-${counter}@example.test`
}

describe('email change', () => {
  it('changes the email only once the link sent to the new address is opened', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const next = freshEmail()

    const asked = await browser.call('POST', '/api/me/email', {
      body: { new_email: ` ${next.toUpperCase()} `, current_password: PASSWORD },
    })
    expect(asked.statusCode).toBe(204)
    const token = tokenFor(next)
    expect(ctx.mailer.sent.find((m) => m.to === next)?.text).toContain(
      `https://gestionale.example.test/conferma-email/${token}`,
    )
    // The old address is warned, without the link.
    const warning = [...ctx.mailer.sent].reverse().find((m) => m.to === user.email)
    expect(warning?.text).toContain(next)
    expect(warning?.text).not.toContain(token)
    // Nothing changes before the confirmation.
    const before = await browser.call('GET', '/api/me')
    expect(before.json<{ email: string }>().email).toBe(user.email)

    // Opened from another device: no session needed, only the CSRF token.
    const other = await guest()
    const done = await other.call('POST', `/api/auth/email-change/${token}`)
    expect(done.statusCode).toBe(204)
    const after = await browser.call('GET', '/api/me')
    expect(after.statusCode).toBe(200)
    expect(after.json<{ email: string }>().email).toBe(next)
    await new Browser(ctx.app).signIn(next)
    const old = await (
      await guest()
    ).call('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } })
    expect(old.statusCode).toBe(422)

    const again = await other.call('POST', `/api/auth/email-change/${token}`)
    expect(again.statusCode).toBe(404)
  })

  it('refuses a wrong password, the same email, a taken email and bad input', async () => {
    const user = await fx.user()
    const someone = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const sent = ctx.mailer.sent.length

    const wrong = await browser.call('POST', '/api/me/email', {
      body: { new_email: freshEmail(), current_password: 'sbagliata-davvero' },
    })
    expect(wrong.statusCode).toBe(422)
    expect(Object.keys(wrong.json<{ errors: object }>().errors)).toEqual(['current_password'])
    for (const [email, field] of [
      [user.email.toUpperCase(), 'new_email'],
      [someone.email, 'new_email'],
      ['non-una-email', 'new_email'],
      ['', 'new_email'],
    ] as const) {
      const res = await browser.call('POST', '/api/me/email', {
        body: { new_email: email, current_password: PASSWORD },
      })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
    }
    const missing = await browser.call('POST', '/api/me/email', { body: {} })
    expect(missing.statusCode).toBe(422)
    expect(ctx.mailer.sent.length).toBe(sent)

    const noCsrf = await browser.call('POST', '/api/me/email', {
      body: { new_email: freshEmail(), current_password: PASSWORD },
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    const anonymous = await (
      await guest()
    ).call('POST', '/api/me/email', {
      body: { new_email: freshEmail(), current_password: PASSWORD },
    })
    expect(anonymous.statusCode).toBe(401)
  })

  it('a new request cancels the earlier link; at most three an hour', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const ask = (email: string) =>
      browser.call('POST', '/api/me/email', {
        body: { new_email: email, current_password: PASSWORD },
      })
    const first = freshEmail()
    expect((await ask(first)).statusCode).toBe(204)
    const firstToken = tokenFor(first)
    const second = freshEmail()
    expect((await ask(second)).statusCode).toBe(204)
    expect((await ask(freshEmail())).statusCode).toBe(204)
    const fourth = await ask(freshEmail())
    expect(fourth.statusCode).toBe(429)

    const visitor = await guest()
    expect((await visitor.call('POST', `/api/auth/email-change/${firstToken}`)).statusCode).toBe(
      404,
    )
    expect(
      (await visitor.call('POST', `/api/auth/email-change/${tokenFor(second)}`)).statusCode,
    ).toBe(404)
  })

  it('an address taken in the meantime answers 409; expired links 404', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const next = freshEmail()
    await browser.call('POST', '/api/me/email', {
      body: { new_email: next, current_password: PASSWORD },
    })
    const token = tokenFor(next)
    // Another account takes the address before the link is opened.
    const thief = await fx.user()
    await ctx.owner.query('update auth.users set email = $2 where id = $1', [thief.id, next])
    const visitor = await guest()
    const taken = await visitor.call('POST', `/api/auth/email-change/${token}`)
    expect(taken.statusCode).toBe(409)
    expect(taken.json()).toMatchObject({ code: 'email_in_use' })
    const me = await browser.call('GET', '/api/me')
    expect(me.json<{ email: string }>().email).toBe(user.email)

    const later = freshEmail()
    await browser.call('POST', '/api/me/email', {
      body: { new_email: later, current_password: PASSWORD },
    })
    const lateToken = tokenFor(later)
    await ctx.owner.query(
      "update auth.email_changes set expires_at = now() - interval '1 minute' where user_id = $1",
      [user.id],
    )
    expect((await visitor.call('POST', `/api/auth/email-change/${lateToken}`)).statusCode).toBe(404)
    const noCsrf = await visitor.call('POST', `/api/auth/email-change/${lateToken}`, {
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect((await visitor.call('POST', '/api/auth/email-change/corto')).statusCode).toBe(404)
  })

  it('a link of a disabled account does nothing', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const next = freshEmail()
    await browser.call('POST', '/api/me/email', {
      body: { new_email: next, current_password: PASSWORD },
    })
    const token = tokenFor(next)
    await ctx.owner.query('update auth.users set active = false where id = $1', [user.id])
    const res = await (await guest()).call('POST', `/api/auth/email-change/${token}`)
    expect(res.statusCode).toBe(404)
    const { rows } = await ctx.owner.query<{ email: string }>(
      'select email from auth.users where id = $1',
      [user.id],
    )
    expect(rows[0]?.email).toBe(user.email)
  })
})
