import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('GET /api/me', () => {
  it('without a session answers 401', async () => {
    const res = await new Browser(ctx.app).call('GET', '/api/me')
    expect(res.statusCode).toBe(401)
  })

  it('lists every company of the user with role and permissions', async () => {
    const user = await fx.user({ name: 'Giulia Rossi' })
    const a = await fx.company('Alfa S.r.l.')
    const b = await fx.company('Beta S.p.A.')
    await fx.member(
      user.id,
      a.id,
      await fx.role(a.id, 'Titolare', ['clients.view', 'clients.update']),
    )
    await fx.member(user.id, b.id, await fx.role(b.id, 'Capo cantiere', ['clients.view']))
    // A company the user does not belong to must not appear
    await fx.company('Gamma S.r.l.')

    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('GET', '/api/me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: user.id,
      name: 'Giulia Rossi',
      email: user.email,
      companies: [
        {
          slug: a.slug,
          name: 'Alfa S.r.l.',
          role: 'Titolare',
          permissions: ['clients.update', 'clients.view'],
        },
        { slug: b.slug, name: 'Beta S.p.A.', role: 'Capo cantiere', permissions: ['clients.view'] },
      ],
    })
  })

  it('a user without companies gets an empty list', async () => {
    const user = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('GET', '/api/me')
    expect(res.json<{ companies: unknown[] }>().companies).toEqual([])
  })

  it('a role with no permissions gives an empty list, not null', async () => {
    const { user } = await fx.companyWithUser([], 'Ospite')
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('GET', '/api/me')
    expect(res.json<{ companies: { permissions: unknown }[] }>().companies[0]?.permissions).toEqual(
      [],
    )
  })
})
