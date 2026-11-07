import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, unique, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const LOGO_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const LOGO_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])

async function invitingCompany(logo?: Buffer) {
  const setup = await fx.companyWithUser(['users.view', 'users.manage'])
  const role = await fx.role(setup.company.id, 'Ufficio', ['clients.view'])
  if (logo) {
    await ctx.owner.query(
      "insert into public.company_logos (company_id, content_type, data) values ($1, 'image/png', $2)",
      [setup.company.id, logo],
    )
  }
  const browser = new Browser(ctx.app)
  await browser.signIn(setup.user.email)
  const res = await browser.call('POST', `/api/companies/${setup.company.slug}/invitations`, {
    body: { email: `logo-${unique()}@example.test`, role_id: role },
  })
  expect(res.statusCode).toBe(201)
  return { ...setup, token: res.json<{ id: string; token: string }>().token }
}

describe('logo on the invitation page', () => {
  it('shows the logo of the inviting company to a visitor without a session', async () => {
    const a = await invitingCompany(LOGO_A)
    await invitingCompany(LOGO_B)
    const visitor = new Browser(ctx.app)
    const preview = await visitor.call('GET', `/api/invitations/${a.token}`)
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ has_logo: true })
    const logo = await visitor.call('GET', `/api/invitations/${a.token}/logo`)
    expect(logo.statusCode).toBe(200)
    expect(logo.headers['content-type']).toBe('image/png')
    expect(logo.headers.etag).toBe('"1"')
    expect(logo.rawPayload.equals(LOGO_A)).toBe(true)
  })

  it('answers 404 without a logo, and has_logo says so first', async () => {
    const a = await invitingCompany()
    const visitor = new Browser(ctx.app)
    const preview = await visitor.call('GET', `/api/invitations/${a.token}`)
    expect(preview.json()).toMatchObject({ has_logo: false })
    expect((await visitor.call('GET', `/api/invitations/${a.token}/logo`)).statusCode).toBe(404)
  })

  it('answers 404 for an unknown, expired or used invitation', async () => {
    const a = await invitingCompany(LOGO_A)
    const visitor = new Browser(ctx.app)
    const bogus = 'x'.repeat(a.token.length)
    expect((await visitor.call('GET', `/api/invitations/${bogus}/logo`)).statusCode).toBe(404)
    expect((await visitor.call('GET', '/api/invitations/%20/logo')).statusCode).toBe(404)

    await ctx.owner.query(
      "update public.invitations set expires_at = now() - interval '1 second' where company_id = $1",
      [a.company.id],
    )
    expect((await visitor.call('GET', `/api/invitations/${a.token}/logo`)).statusCode).toBe(404)
  })
})
