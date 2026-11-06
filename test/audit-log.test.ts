import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

type Entry = {
  entity: string
  entity_id: string
  action: string
  fields: string[]
  user: { id: string; name: string } | null
}

const estimate = (overrides: Record<string, unknown> = {}) => ({
  title: 'Bagno',
  client_id: null,
  site_id: null,
  site_address: null,
  status: 'draft',
  notes: null,
  ...overrides,
})

describe('audit log', () => {
  it('records who created, changed and deleted a record, newest first', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'estimates.view',
      'estimates.create',
      'estimates.update',
      'estimates.delete',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}/estimates`
    const created = await browser.call('POST', base, { body: estimate() })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const url = `${base}/${id}`
    const headers = { 'if-match': '"1"' }
    const same = await browser.call('PUT', url, { body: estimate(), headers })
    expect(same.statusCode).toBe(200)
    const changed = await browser.call('PUT', url, {
      body: estimate({ title: 'Bagno e cucina', status: 'final' }),
      headers: { 'if-match': '"2"' },
    })
    expect(changed.statusCode).toBe(200)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"3"' } })).statusCode).toBe(
      204,
    )
    // A change made outside the API has no author.
    await ctx.owner.query(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Senza autore')",
      [company.id],
    )

    const log = `/api/companies/${company.slug}/audit-log`
    const all = await browser.call('GET', log)
    expect(all.statusCode).toBe(200)
    const entries = all.json<{ data: Entry[]; meta: { total: number } }>()
    expect(entries.meta.total).toBe(4)
    const author = { id: user.id, name: 'Utente di prova' }
    expect(entries.data).toMatchObject([
      { entity: 'client', action: 'create', fields: [], user: null },
      { entity: 'estimate', entity_id: id, action: 'delete', fields: [], user: author },
      { entity: 'estimate', action: 'update', fields: ['status', 'title'], user: author },
      { entity: 'estimate', action: 'create', fields: [], user: author },
    ])

    const history = await browser.call(
      'GET',
      `${log}?filter[entity]=estimate&filter[entity_id]=${id}&per_page=1&page=2`,
    )
    const page = history.json<{ data: Entry[]; meta: { total: number } }>()
    expect(page.meta.total).toBe(3)
    expect(page.data.map((e) => e.action)).toEqual(['update'])
    const byUser = await browser.call('GET', `${log}?filter[user]=${user.id}`)
    expect(byUser.json<{ meta: { total: number } }>().meta.total).toBe(3)
    expect((await browser.call('GET', `${log}?filter[entity]=boh`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${log}?filter[entity_id]=x`)).statusCode).toBe(422)
  })

  it('needs audit.view and shows only the company of the URL', async () => {
    const reader = await fx.companyWithUser(['estimates.view', 'estimates.create'])
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.user.email)
    const created = await browser.call('POST', `/api/companies/${reader.company.slug}/estimates`, {
      body: estimate({ title: 'Segreto' }),
    })
    expect(created.statusCode).toBe(201)
    const log = `/api/companies/${reader.company.slug}/audit-log`
    expect((await browser.call('GET', log)).statusCode).toBe(403)

    const auditor = await fx.companyWithUser(['audit.view'])
    const other = new Browser(ctx.app)
    await other.signIn(auditor.user.email)
    expect((await other.call('GET', log)).statusCode).toBe(404)
    const own = await other.call('GET', `/api/companies/${auditor.company.slug}/audit-log`)
    expect(own.json<{ meta: { total: number } }>().meta.total).toBe(0)
  })
})
