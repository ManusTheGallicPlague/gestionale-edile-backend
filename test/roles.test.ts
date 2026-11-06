import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('roles', () => {
  it('lists the roles of the company in the URL, with sorted permissions', async () => {
    const { company, user, roleId } = await fx.companyWithUser(['users.view', 'clients.view'])
    const office = await fx.role(company.id, 'Ufficio', ['quotes.view', 'clients.create'])
    const empty = await fx.role(company.id, 'Archivio', [])
    // The same user in another company, with roles that must not show up here.
    const other = await fx.company('Altra impresa')
    const otherRole = await fx.role(other.id, 'Segreto', ['users.view'])
    await fx.member(user.id, other.id, otherRole)
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)

    const res = await browser.call('GET', `/api/companies/${company.slug}/roles`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        { id: empty, name: 'Archivio', permissions: [] },
        { id: roleId, name: 'Titolare', permissions: ['clients.view', 'users.view'] },
        { id: office, name: 'Ufficio', permissions: ['clients.create', 'quotes.view'] },
      ],
    })
    const theirs = await browser.call('GET', `/api/companies/${other.slug}/roles`)
    expect(theirs.json()).toEqual({
      data: [{ id: otherRole, name: 'Segreto', permissions: ['users.view'] }],
    })
  })

  it('needs users.view and membership', async () => {
    const { company, user } = await fx.companyWithUser(['clients.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    expect((await browser.call('GET', `/api/companies/${company.slug}/roles`)).statusCode).toBe(403)
    const stranger = await fx.companyWithUser(['users.view'])
    const outsider = new Browser(ctx.app)
    await outsider.signIn(stranger.user.email)
    expect((await outsider.call('GET', `/api/companies/${company.slug}/roles`)).statusCode).toBe(
      404,
    )
  })

  it('lists the users of the company in the URL, never those of other companies', async () => {
    const { company, user, roleId } = await fx.companyWithUser(['users.view'])
    const colleague = await fx.user({ name: 'Anna Bassi' })
    const office = await fx.role(company.id, 'Ufficio', [])
    await fx.member(colleague.id, company.id, office)
    const other = await fx.companyWithUser(['users.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('GET', `/api/companies/${company.slug}/users`)
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { id: string; email: string; role: { id: string } }[] }>().data
    expect(data.map((u) => u.id).sort()).toEqual([user.id, colleague.id].sort())
    expect(data[0]).toMatchObject({ id: colleague.id, active: true, role: { id: office } })
    expect(data.find((u) => u.id === user.id)?.role.id).toBe(roleId)
    expect(JSON.stringify(data)).not.toContain('password')
    expect(data.some((u) => u.id === other.user.id)).toBe(false)
    expect(
      (await browser.call('GET', `/api/companies/${other.company.slug}/users`)).statusCode,
    ).toBe(404)
    const blind = await fx.companyWithUser(['clients.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    expect((await b.call('GET', `/api/companies/${blind.company.slug}/users`)).statusCode).toBe(403)
  })
})
