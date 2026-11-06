import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function team() {
  const setup = await fx.companyWithUser(['users.view', 'users.manage', 'clients.view'])
  const office = await fx.role(setup.company.id, 'Ufficio', ['clients.view'])
  const colleague = await fx.user({ name: 'Collega' })
  await fx.member(colleague.id, setup.company.id, office)
  const browser = new Browser(ctx.app)
  await browser.signIn(setup.user.email)
  const them = new Browser(ctx.app)
  await them.signIn(colleague.email)
  const base = `/api/companies/${setup.company.slug}/users`
  return { ...setup, office, colleague, browser, them, base }
}

describe('managing members', () => {
  it('changes the role, effective at once for the open session', async () => {
    const { company, roleId, colleague, browser, them, base } = await team()
    expect((await them.call('GET', `/api/companies/${company.slug}/users`)).statusCode).toBe(403)
    const res = await browser.call('PUT', `${base}/${colleague.id}/role`, {
      body: { role_id: roleId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: colleague.id,
      active: true,
      role: { id: roleId, name: 'Titolare' },
    })
    expect((await them.call('GET', `/api/companies/${company.slug}/users`)).statusCode).toBe(200)
  })

  it('validates the role: required, and only of this company', async () => {
    const { colleague, browser, base } = await team()
    const other = await fx.company()
    const foreign = await fx.role(other.id, 'Altrui', ['users.manage'])
    for (const body of [{}, { role_id: 'x' }, { role_id: foreign }]) {
      const res = await browser.call('PUT', `${base}/${colleague.id}/role`, { body })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['role_id'])
    }
  })

  it('deactivates and reactivates: access to the company goes and comes back', async () => {
    const { company, colleague, browser, them, base } = await team()
    const off = await browser.call('POST', `${base}/${colleague.id}/deactivate`)
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ id: colleague.id, active: false })
    // Twice changes nothing.
    expect((await browser.call('POST', `${base}/${colleague.id}/deactivate`)).statusCode).toBe(200)

    expect((await them.call('GET', `/api/companies/${company.slug}/clients`)).statusCode).toBe(404)
    expect((await them.call('GET', '/api/me')).json()).toMatchObject({ companies: [] })
    const list = await browser.call('GET', base)
    expect(list.json<{ data: { id: string; active: boolean }[] }>().data).toContainEqual(
      expect.objectContaining({ id: colleague.id, active: false }),
    )

    const on = await browser.call('POST', `${base}/${colleague.id}/reactivate`)
    expect(on.json()).toMatchObject({ active: true, role: { name: 'Ufficio' } })
    expect((await them.call('GET', `/api/companies/${company.slug}/clients`)).statusCode).toBe(200)
  })

  it('never leaves the company without an active user who can manage users', async () => {
    const { user, office, colleague, browser, base } = await team()
    const self = await browser.call('POST', `${base}/${user.id}/deactivate`)
    expect(self.statusCode).toBe(409)
    expect(self.json()).toMatchObject({ code: 'self_deactivation' })
    const demote = await browser.call('PUT', `${base}/${user.id}/role`, {
      body: { role_id: office },
    })
    expect(demote.statusCode).toBe(409)
    expect(demote.json()).toMatchObject({ code: 'last_manager' })
    // Nothing changed.
    const list = await browser.call('GET', base)
    const mine = list
      .json<{ data: { id: string; role: { name: string } }[] }>()
      .data.find((u) => u.id === user.id)
    expect(mine?.role.name).toBe('Titolare')

    // With a second manager the first can step down.
    const managerRole = list
      .json<{ data: { id: string; role: { id: string } }[] }>()
      .data.find((u) => u.id === user.id)?.role.id
    await browser.call('PUT', `${base}/${colleague.id}/role`, { body: { role_id: managerRole } })
    const ok = await browser.call('PUT', `${base}/${user.id}/role`, { body: { role_id: office } })
    expect(ok.statusCode).toBe(200)
  })

  it('needs users.manage and only reaches members of this company', async () => {
    const { company, colleague, them, browser, base } = await team()
    expect((await them.call('POST', `${base}/${colleague.id}/deactivate`)).statusCode).toBe(403)
    const stranger = await fx.companyWithUser(['users.manage'])
    // A user of another company is not found here, and this company is not found for them.
    expect((await browser.call('POST', `${base}/${stranger.user.id}/deactivate`)).statusCode).toBe(
      404,
    )
    expect((await browser.call('POST', `${base}/nope/reactivate`)).statusCode).toBe(404)
    const s = new Browser(ctx.app)
    await s.signIn(stranger.user.email)
    expect(
      (await s.call('POST', `/api/companies/${company.slug}/users/${colleague.id}/deactivate`))
        .statusCode,
    ).toBe(404)
    // The CSRF token is required.
    const res = await browser.call('POST', `${base}/${colleague.id}/deactivate`, { csrf: false })
    expect(res.statusCode).toBe(403)
  })
})
