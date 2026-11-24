/**
 * Links in the emails (password reset, invitation, email change) carry the only secret of
 * their page: wrong ones are counted per IP and, after too many, answered 429.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LOGIN_LIMITS } from '../src/config.js'
import { Browser, Fixtures, mailedToken, startApp, unique, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const MAX = DEFAULT_LOGIN_LIMITS.maxLinkFailuresPerIp
const BOGUS = 'x'.repeat(43)

async function guest() {
  const browser = new Browser(ctx.app)
  await browser.request('GET', '/api/auth/csrf')
  return browser
}

/** An invitation to a new person; its token, from the email. */
async function invitation(): Promise<string> {
  const setup = await fx.companyWithUser(['users.view', 'users.manage'])
  const role = await fx.role(setup.company.id, 'Ufficio', ['clients.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(setup.user.email)
  const email = `link-${unique()}@example.test`
  const res = await browser.call('POST', `/api/companies/${setup.company.slug}/invitations`, {
    body: { email, role_id: role },
  })
  expect(res.statusCode).toBe(201)
  return mailedToken(ctx.mailer, email, 'invito')
}

async function resetToken(): Promise<string> {
  const user = await fx.user()
  const visitor = await guest()
  const res = await visitor.call('POST', '/api/auth/password-reset', {
    body: { email: user.email },
  })
  expect(res.statusCode).toBe(204)
  return mailedToken(ctx.mailer, user.email, 'password-dimenticata')
}

type Use = (browser: Browser, token: string) => ReturnType<Browser['call']>

/** Each way of using a link, with a request that carries the given token. */
const uses: [string, Use][] = [
  ['GET /api/invitations/{token}', (b, t) => b.call('GET', `/api/invitations/${t}`)],
  ['GET /api/invitations/{token}/logo', (b, t) => b.call('GET', `/api/invitations/${t}/logo`)],
  [
    'POST /api/invitations/{token}/accept',
    (b, t) =>
      b.call('POST', `/api/invitations/${t}/accept`, {
        body: { name: 'Nuova Persona', password: 'una-password-lunga' },
      }),
  ],
  [
    'POST /api/auth/password-reset/{token}',
    (b, t) =>
      b.call('POST', `/api/auth/password-reset/${t}`, {
        body: { new_password: 'password-ritrovata' },
      }),
  ],
  ['POST /api/auth/email-change/{token}', (b, t) => b.call('POST', `/api/auth/email-change/${t}`)],
]

describe('limit on wrong links, per IP', () => {
  it.each(uses)('%s: after too many wrong links answers 429', async (_, use) => {
    const visitor = await guest()
    for (let i = 0; i < MAX; i++) expect((await use(visitor, BOGUS)).statusCode).toBe(404)
    const blocked = await use(visitor, BOGUS)
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('is one limit for every kind of link; a good link still works from another IP', async () => {
    const invited = await invitation()
    const reset = await resetToken()
    const visitor = await guest()
    // Wrong links of every kind add up
    for (let i = 0; i < MAX; i++) {
      const use = uses[i % uses.length]?.[1]
      if (!use) throw new Error('no use')
      expect((await use(visitor, BOGUS)).statusCode).toBe(404)
    }
    expect((await visitor.call('GET', `/api/invitations/${invited}`)).statusCode).toBe(429)
    const resetBlocked = await visitor.call('POST', `/api/auth/password-reset/${reset}`, {
      body: { new_password: 'password-ritrovata' },
    })
    expect(resetBlocked.statusCode).toBe(429)

    // The links were not spent: from another address they work
    const other = await guest()
    expect((await other.call('GET', `/api/invitations/${invited}`)).statusCode).toBe(200)
    const done = await other.call('POST', `/api/auth/password-reset/${reset}`, {
      body: { new_password: 'password-ritrovata' },
    })
    expect(done.statusCode).toBe(204)
  })

  it('good links do not count', async () => {
    const invited = await invitation()
    const visitor = await guest()
    for (let i = 0; i < MAX + 5; i++) {
      expect((await visitor.call('GET', `/api/invitations/${invited}`)).statusCode).toBe(200)
    }
  })
})

describe('limit on password reset requests, per IP', () => {
  const max = DEFAULT_LOGIN_LIMITS.maxResetRequestsPerIp

  it('after too many requests answers 429, whatever the email', async () => {
    const visitor = await guest()
    for (let i = 0; i < max; i++) {
      const res = await visitor.call('POST', '/api/auth/password-reset', {
        body: { email: `nessuno-${i}-${unique()}@example.test` },
      })
      expect(res.statusCode).toBe(204)
    }
    const user = await fx.user()
    const before = ctx.mailer.sent.length
    const blocked = await visitor.call('POST', '/api/auth/password-reset', {
      body: { email: user.email },
    })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(ctx.mailer.sent.length).toBe(before)

    // Another address is not affected
    const other = await guest()
    const res = await other.call('POST', '/api/auth/password-reset', {
      body: { email: user.email },
    })
    expect(res.statusCode).toBe(204)
    expect(ctx.mailer.sent.length).toBe(before + 1)
  })

  it('a refused body does not count', async () => {
    const visitor = await guest()
    for (let i = 0; i < max + 2; i++) {
      const res = await visitor.call('POST', '/api/auth/password-reset', { body: { email: 'x' } })
      expect(res.statusCode).toBe(422)
    }
    const res = await visitor.call('POST', '/api/auth/password-reset', {
      body: { email: `nessuno-${unique()}@example.test` },
    })
    expect(res.statusCode).toBe(204)
  })
})
