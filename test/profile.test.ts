import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('profile', () => {
  it('changes the own name, and only that', async () => {
    const { company, user } = await fx.companyWithUser(['clients.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('PUT', '/api/me', {
      body: { name: '  Mario Bianchi  ', email: 'altro@example.test' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: user.id,
      name: 'Mario Bianchi',
      email: user.email,
      companies: [{ slug: company.slug }],
    })
    expect((await browser.call('GET', '/api/me')).json()).toMatchObject({ name: 'Mario Bianchi' })
    const empty = await browser.call('PUT', '/api/me', { body: { name: ' ' } })
    expect(empty.statusCode).toBe(422)
    expect(Object.keys(empty.json<{ errors: object }>().errors)).toEqual(['name'])
    expect(
      (await browser.call('PUT', '/api/me', { body: { name: 'X' }, csrf: false })).statusCode,
    ).toBe(403)
    expect(
      (await new Browser(ctx.app).call('PUT', '/api/me', { body: { name: 'X' } })).statusCode,
    ).toBe(401)
  })

  it('changes the password and closes the other sessions, not this one', async () => {
    const user = await fx.user()
    const here = new Browser(ctx.app)
    await here.signIn(user.email)
    const phone = new Browser(ctx.app)
    await phone.signIn(user.email)

    const res = await here.call('POST', '/api/me/password', {
      body: { current_password: PASSWORD, new_password: 'nuova-password-lunga' },
    })
    expect(res.statusCode).toBe(204)
    expect((await here.call('GET', '/api/me')).statusCode).toBe(200)
    expect((await phone.call('GET', '/api/me')).statusCode).toBe(401)

    const fresh = new Browser(ctx.app)
    await fresh.request('GET', '/api/auth/csrf')
    const old = await fresh.call('POST', '/api/auth/login', {
      body: { email: user.email, password: PASSWORD },
    })
    expect(old.statusCode).toBe(422)
    await fresh.signIn(user.email, 'nuova-password-lunga')
  })

  it('checks the current password, under the sign-in limits, and the new one', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const { rows: initial } = await ctx.owner.query<{ password_hash: string }>(
      'select password_hash from auth.users where id = $1',
      [user.id],
    )
    const before = initial[0]?.password_hash
    const short = await browser.call('POST', '/api/me/password', {
      body: { current_password: PASSWORD, new_password: 'corta' },
    })
    expect(short.statusCode).toBe(422)
    expect(Object.keys(short.json<{ errors: object }>().errors)).toEqual(['new_password'])

    let last = 0
    for (let i = 0; i < 12; i++) {
      const res = await browser.call('POST', '/api/me/password', {
        body: { current_password: 'sbagliata', new_password: 'nuova-password-lunga' },
      })
      last = res.statusCode
      if (res.statusCode === 422) {
        expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['current_password'])
      }
      if (last === 429) break
    }
    expect(last).toBe(429)
    // The password did not change.
    const { rows } = await ctx.owner.query<{ password_hash: string }>(
      'select password_hash from auth.users where id = $1',
      [user.id],
    )
    expect(rows[0]?.password_hash).toBe(before)
  })
})
