import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, unique, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function ownerWithRole() {
  const setup = await fx.companyWithUser(['users.view', 'users.manage'])
  const office = await fx.role(setup.company.id, 'Ufficio', ['clients.view'])
  const browser = new Browser(ctx.app)
  await browser.signIn(setup.user.email)
  return { ...setup, office, browser }
}

async function invite(browser: Browser, slug: string, email: string, roleId: string) {
  const res = await browser.call('POST', `/api/companies/${slug}/invitations`, {
    body: { email, role_id: roleId },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ id: string; token: string; status: string; role: { id: string } }>()
}

/** A browser with no session, holding the pre-session CSRF token. */
async function guest() {
  const browser = new Browser(ctx.app)
  await browser.request('GET', '/api/auth/csrf')
  return browser
}

describe('invitations', () => {
  it('invites a new person, who creates the account and lands in the company', async () => {
    const { company, office, browser } = await ownerWithRole()
    const email = `nuovo-${unique()}@example.test`
    const created = await invite(browser, company.slug, ` ${email.toUpperCase()} `, office)
    expect(created).toMatchObject({ email, status: 'pending', role: { id: office } })
    expect(created.token.length).toBeGreaterThanOrEqual(20)

    const list = await browser.call('GET', `/api/companies/${company.slug}/invitations`)
    expect(list.json<{ data: unknown[] }>().data).toEqual([
      expect.objectContaining({ id: created.id, email, status: 'pending' }),
    ])
    expect(list.body).not.toContain(created.token)

    const newcomer = await guest()
    const preview = await newcomer.call('GET', `/api/invitations/${created.token}`)
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      company_name: company.name,
      email,
      role_name: 'Ufficio',
      account_exists: false,
    })

    const short = await newcomer.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Nuova Persona', password: 'corta' },
    })
    expect(short.statusCode).toBe(422)
    expect(Object.keys(short.json<{ errors: object }>().errors)).toEqual(['password'])
    const noName = await newcomer.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: '  ', password: 'una-password-lunga' },
    })
    expect(Object.keys(noName.json<{ errors: object }>().errors)).toEqual(['name'])

    const accepted = await newcomer.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Nuova Persona', password: 'una-password-lunga' },
    })
    expect(accepted.statusCode).toBe(204)
    const me = await newcomer.call('GET', '/api/me')
    expect(me.json()).toMatchObject({
      name: 'Nuova Persona',
      email,
      companies: [{ slug: company.slug, role: 'Ufficio', permissions: ['clients.view'] }],
    })
    // The account works for a normal sign-in too.
    await new Browser(ctx.app).signIn(email, 'una-password-lunga')

    // The link works once, and the invitation leaves the list.
    expect((await newcomer.call('GET', `/api/invitations/${created.token}`)).statusCode).toBe(404)
    const again = await (
      await guest()
    ).call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Altro', password: 'una-password-lunga' },
    })
    expect(again.statusCode).toBe(404)
    const after = await browser.call('GET', `/api/companies/${company.slug}/invitations`)
    expect(after.json<{ data: unknown[] }>().data).toEqual([])
    const users = await browser.call('GET', `/api/companies/${company.slug}/users`)
    expect(users.body).toContain(email)
  })

  it('an existing account joins with its own password, under the sign-in limits', async () => {
    const { company, office, browser } = await ownerWithRole()
    const elsewhere = await fx.companyWithUser(['clients.view'])
    const created = await invite(browser, company.slug, elsewhere.user.email, office)

    const them = await guest()
    const preview = await them.call('GET', `/api/invitations/${created.token}`)
    expect(preview.json()).toMatchObject({ account_exists: true })
    const wrong = await them.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { password: 'non-e-la-sua' },
    })
    expect(wrong.statusCode).toBe(422)
    expect(Object.keys(wrong.json<{ errors: object }>().errors)).toEqual(['password'])
    // The name sent is ignored: the account keeps its own.
    const ok = await them.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Nome cambiato', password: PASSWORD },
    })
    expect(ok.statusCode).toBe(204)
    const me = await them.call('GET', '/api/me')
    const body = me.json<{ name: string; companies: { slug: string }[] }>()
    expect(body.name).toBe(elsewhere.user.name)
    expect(body.companies.map((c) => c.slug).sort()).toEqual(
      [company.slug, elsewhere.company.slug].sort(),
    )
  })

  it('refuses to invite a member, and checks email and role', async () => {
    const { company, user, office, browser } = await ownerWithRole()
    const url = `/api/companies/${company.slug}/invitations`
    const member = await browser.call('POST', url, {
      body: { email: user.email.toUpperCase(), role_id: office },
    })
    expect(member.statusCode).toBe(409)
    expect(member.json()).toMatchObject({ code: 'already_member' })

    const other = await fx.company()
    const foreignRole = await fx.role(other.id, 'Ruolo altrui', [])
    const bad = await browser.call('POST', url, {
      body: { email: 'non-una-email', role_id: foreignRole },
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json<{ errors: object }>().errors).toEqual({
      email: [expect.any(String)],
    })
    const foreign = await browser.call('POST', url, {
      body: { email: `x-${unique()}@example.test`, role_id: foreignRole },
    })
    expect(foreign.statusCode).toBe(422)
    expect(Object.keys(foreign.json<{ errors: object }>().errors)).toEqual(['role_id'])
    const missing = await browser.call('POST', url, { body: {} })
    expect(Object.keys(missing.json<{ errors: object }>().errors).sort()).toEqual([
      'email',
      'role_id',
    ])
  })

  it('a new invitation replaces the old one; deleting kills the link', async () => {
    const { company, office, browser } = await ownerWithRole()
    const email = `doppio-${unique()}@example.test`
    const first = await invite(browser, company.slug, email, office)
    const second = await invite(browser, company.slug, email, office)
    const visitor = await guest()
    expect((await visitor.call('GET', `/api/invitations/${first.token}`)).statusCode).toBe(404)
    expect((await visitor.call('GET', `/api/invitations/${second.token}`)).statusCode).toBe(200)

    const url = `/api/companies/${company.slug}/invitations/${second.id}`
    expect((await browser.call('DELETE', url)).statusCode).toBe(204)
    expect((await browser.call('DELETE', url)).statusCode).toBe(404)
    expect((await visitor.call('GET', `/api/invitations/${second.token}`)).statusCode).toBe(404)
    expect(
      (await browser.call('DELETE', `/api/companies/${company.slug}/invitations/nope`)).statusCode,
    ).toBe(404)
  })

  it('expired invitations are listed as expired and cannot be accepted', async () => {
    const { company, office, browser } = await ownerWithRole()
    const created = await invite(browser, company.slug, `tardi-${unique()}@example.test`, office)
    await ctx.owner.query(
      "update public.invitations set expires_at = now() - interval '1 day' where id = $1",
      [created.id],
    )
    const list = await browser.call('GET', `/api/companies/${company.slug}/invitations`)
    expect(list.json()).toMatchObject({ data: [{ id: created.id, status: 'expired' }] })
    const visitor = await guest()
    expect((await visitor.call('GET', `/api/invitations/${created.token}`)).statusCode).toBe(404)
    const accept = await visitor.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Tardi', password: 'una-password-lunga' },
    })
    expect(accept.statusCode).toBe(404)
  })

  it('needs users.manage, membership and the CSRF token', async () => {
    const { company, office, browser } = await ownerWithRole()
    const created = await invite(browser, company.slug, `csrf-${unique()}@example.test`, office)
    const viewer = await fx.user()
    const viewRole = await fx.role(company.id, 'Solo vista', ['users.view'])
    await fx.member(viewer.id, company.id, viewRole)
    const v = new Browser(ctx.app)
    await v.signIn(viewer.email)
    const url = `/api/companies/${company.slug}/invitations`
    expect((await v.call('GET', url)).statusCode).toBe(403)
    expect(
      (await v.call('POST', url, { body: { email: 'z@example.test', role_id: office } }))
        .statusCode,
    ).toBe(403)
    expect((await v.call('DELETE', `${url}/${created.id}`)).statusCode).toBe(403)

    // Another company's manager sees nothing, not even the invitation by id.
    const stranger = await ownerWithRole()
    expect((await stranger.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (
        await stranger.browser.call(
          'DELETE',
          `/api/companies/${stranger.company.slug}/invitations/${created.id}`,
        )
      ).statusCode,
    ).toBe(404)

    const noCsrf = await guest()
    const res = await noCsrf.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { name: 'Senza token', password: 'una-password-lunga' },
      csrf: false,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'csrf_invalid' })
    expect((await noCsrf.call('GET', `/api/invitations/${created.token}`)).statusCode).toBe(200)
    expect((await noCsrf.call('GET', '/api/invitations/corto')).statusCode).toBe(404)
  })

  it('a member who opens their own invitation gets already_member', async () => {
    const { company, office, browser } = await ownerWithRole()
    const late = await fx.user()
    const created = await invite(browser, company.slug, late.email, office)
    // They were added some other way in the meantime.
    await fx.member(late.id, company.id, office)
    const them = await guest()
    const res = await them.call('POST', `/api/invitations/${created.token}/accept`, {
      body: { password: PASSWORD },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'already_member' })
  })
})
