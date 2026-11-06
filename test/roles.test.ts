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

  it('creates, renames, changes and deletes roles', async () => {
    const { company, user } = await fx.companyWithUser(['users.view', 'roles.manage'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const url = `/api/companies/${company.slug}/roles`
    const created = await browser.call('POST', url, {
      body: {
        name: ' Magazzino ',
        permissions: ['suppliers.view', 'clients.view', 'clients.view'],
      },
    })
    expect(created.statusCode).toBe(201)
    const role = created.json<{ id: string }>()
    expect(role).toMatchObject({
      name: 'Magazzino',
      permissions: ['clients.view', 'suppliers.view'],
    })

    const dup = await browser.call('POST', url, { body: { name: 'Magazzino', permissions: [] } })
    expect(dup.statusCode).toBe(422)
    expect(Object.keys(dup.json<{ errors: object }>().errors)).toEqual(['name'])
    const bad = await browser.call('POST', url, {
      body: { name: '', permissions: ['clients.fly'] },
    })
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'name',
      'permissions',
    ])

    const updated = await browser.call('PUT', `${url}/${role.id}`, {
      body: { name: 'Magazzino e mezzi', permissions: ['deadlines.view'] },
    })
    expect(updated.json()).toEqual({
      id: role.id,
      name: 'Magazzino e mezzi',
      permissions: ['deadlines.view'],
    })
    const list = await browser.call('GET', url)
    expect(list.json<{ data: unknown[] }>().data).toContainEqual(updated.json())
    const clash = await browser.call('PUT', `${url}/${role.id}`, {
      body: { name: 'Titolare', permissions: [] },
    })
    expect(clash.statusCode).toBe(422)

    // A role in use, even by a deactivated member, cannot be deleted.
    const member = await fx.user()
    await fx.member(member.id, company.id, role.id)
    await ctx.owner.query('update public.memberships set disabled_at = now() where user_id = $1', [
      member.id,
    ])
    const inUse = await browser.call('DELETE', `${url}/${role.id}`)
    expect(inUse.statusCode).toBe(409)
    expect(inUse.json()).toMatchObject({ code: 'role_in_use' })
    await ctx.owner.query('delete from public.memberships where user_id = $1', [member.id])
    expect((await browser.call('DELETE', `${url}/${role.id}`)).statusCode).toBe(204)
    expect((await browser.call('DELETE', `${url}/${role.id}`)).statusCode).toBe(404)
  })

  it('a permission change applies at once to who has the role', async () => {
    const { company, user, roleId } = await fx.companyWithUser([
      'users.view',
      'users.manage',
      'roles.manage',
    ])
    const office = await fx.role(company.id, 'Ufficio', ['clients.view'])
    const clerk = await fx.user()
    await fx.member(clerk.id, company.id, office)
    const them = new Browser(ctx.app)
    await them.signIn(clerk.email)
    const clients = `/api/companies/${company.slug}/clients`
    expect((await them.call('GET', clients)).statusCode).toBe(200)
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await browser.call('PUT', `/api/companies/${company.slug}/roles/${office}`, {
      body: { name: 'Ufficio', permissions: [] },
    })
    expect((await them.call('GET', clients)).statusCode).toBe(403)

    // Nobody can take away the last users.manage or roles.manage.
    for (const permissions of [
      ['users.view', 'roles.manage'],
      ['users.view', 'users.manage'],
    ]) {
      const res = await browser.call('PUT', `/api/companies/${company.slug}/roles/${roleId}`, {
        body: { name: 'Titolare', permissions },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'last_manager' })
    }
    const me = await browser.call('GET', '/api/me')
    expect(me.body).toContain('roles.manage')
  })

  it('managing roles needs roles.manage and stays in the company', async () => {
    const { company, roleId, user } = await fx.companyWithUser(['users.view', 'users.manage'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const url = `/api/companies/${company.slug}/roles`
    expect(
      (await browser.call('POST', url, { body: { name: 'X', permissions: [] } })).statusCode,
    ).toBe(403)
    expect(
      (await browser.call('PUT', `${url}/${roleId}`, { body: { name: 'X', permissions: [] } }))
        .statusCode,
    ).toBe(403)
    expect((await browser.call('DELETE', `${url}/${roleId}`)).statusCode).toBe(403)

    // A manager of another company, where the same user may also be: the URL decides.
    const other = await fx.companyWithUser(['roles.manage'])
    const o = new Browser(ctx.app)
    await o.signIn(other.user.email)
    const theirUrl = `/api/companies/${other.company.slug}/roles/${roleId}`
    expect(
      (await o.call('PUT', theirUrl, { body: { name: 'Preso', permissions: [] } })).statusCode,
    ).toBe(404)
    expect((await o.call('DELETE', theirUrl)).statusCode).toBe(404)
    expect(
      (await o.call('PUT', `${url}/${roleId}`, { body: { name: 'Y', permissions: [] } }))
        .statusCode,
    ).toBe(404)
  })
})
