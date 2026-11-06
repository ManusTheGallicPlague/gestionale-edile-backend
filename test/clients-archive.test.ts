import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
  // Stands in for the documents that will link to clients (quotes, estimates, deadlines):
  // they must reference clients with "on delete restrict", as this table does.
  await ctx.owner.query(
    `create table if not exists public.test_client_documents (
       id serial primary key,
       client_id uuid not null references public.clients (id) on delete restrict
     )`,
  )
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['clients.view', 'clients.create', 'clients.update', 'clients.delete']

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}/clients`
  // Created as the owner, so a scene without clients.create still has a client.
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Edil Archivio', $2) returning id",
    [company.id, newVat()],
  )
  const id = rows[0]?.id ?? ''
  return { browser, base, company, id, url: `${base}/${id}` }
}

const names = (res: { json(): unknown }) =>
  (res.json() as { data: { id: string; archived_at: string | null }[] }).data

describe('archive and restore', () => {
  it('archives with If-Match: the client leaves the default list and enters the archived one', async () => {
    const { browser, base, url, id } = await scene()
    const fresh = await browser.call('GET', url)
    expect(fresh.json()).toMatchObject({ archived_at: null })

    const res = await browser.call('POST', `${url}/archive`, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('"2"')
    const archivedAt = res.json<{ archived_at: string }>().archived_at
    expect(Date.parse(archivedAt)).not.toBeNaN()

    const active = await browser.call('GET', base)
    expect(names(active).map((c) => c.id)).not.toContain(id)
    const explicitActive = await browser.call('GET', `${base}?filter[archived]=false`)
    expect(names(explicitActive).map((c) => c.id)).not.toContain(id)
    const archived = await browser.call('GET', `${base}?filter[archived]=true`)
    expect(names(archived).map((c) => c.id)).toEqual([id])
    expect(archived.json()).toMatchObject({ meta: { total: 1 } })

    // Still readable on its own page, with its documents.
    const page = await browser.call('GET', url)
    expect(page.statusCode).toBe(200)
    expect(page.json()).toMatchObject({ archived_at: archivedAt })
  })

  it('archiving twice keeps the first date; restore brings it back', async () => {
    const { browser, base, url, id } = await scene()
    const first = await browser.call('POST', `${url}/archive`, { headers: { 'if-match': '"1"' } })
    const again = await browser.call('POST', `${url}/archive`, { headers: { 'if-match': '"2"' } })
    expect(again.json<{ archived_at: string }>().archived_at).toBe(
      first.json<{ archived_at: string }>().archived_at,
    )

    const restored = await browser.call('POST', `${url}/restore`, {
      headers: { 'if-match': '"3"' },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ archived_at: null })
    expect(restored.headers.etag).toBe('"4"')
    const active = await browser.call('GET', base)
    expect(names(active).map((c) => c.id)).toContain(id)
  })

  it('a stale ETag is 412, a missing one 428, and nothing changes', async () => {
    const { browser, url } = await scene()
    const stale = await browser.call('POST', `${url}/archive`, { headers: { 'if-match': '"7"' } })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({ code: 'stale_record' })
    const missing = await browser.call('POST', `${url}/archive`)
    expect(missing.statusCode).toBe(428)
    expect(missing.json()).toMatchObject({ code: 'precondition_required' })
    const page = await browser.call('GET', url)
    expect(page.json()).toMatchObject({ archived_at: null })
    expect(page.headers.etag).toBe('"1"')
  })

  it('needs clients.update and the CSRF token', async () => {
    const { browser, url } = await scene(['clients.view'])
    const res = await browser.call('POST', `${url}/archive`, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(403)

    const full = await scene()
    const noCsrf = await full.browser.call('POST', `${full.url}/restore`, {
      headers: { 'if-match': '"1"' },
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json()).toMatchObject({ code: 'csrf_invalid' })
  })

  it('a client of another company is 404, for archive, restore and delete', async () => {
    const mine = await scene()
    const theirs = await scene()
    for (const action of ['archive', 'restore'] as const) {
      const res = await mine.browser.call('POST', `${mine.base}/${theirs.id}/${action}`, {
        headers: { 'if-match': '"1"' },
      })
      expect(res.statusCode).toBe(404)
    }
    const del = await mine.browser.call('DELETE', `${mine.base}/${theirs.id}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(del.statusCode).toBe(404)
    const untouched = await theirs.browser.call('GET', theirs.url)
    expect(untouched.statusCode).toBe(200)
    expect(untouched.json()).toMatchObject({ archived_at: null })
    expect(untouched.headers.etag).toBe('"1"')
  })

  it('refuses a filter[archived] that is not true or false', async () => {
    const { browser, base } = await scene()
    const res = await browser.call('GET', `${base}?filter[archived]=forse`)
    expect(res.statusCode).toBe(422)
    expect(
      res.json<{ errors: Record<string, string[]> }>().errors['filter[archived]'],
    ).toHaveLength(1)
  })
})

describe('delete', () => {
  it('deletes a client without documents', async () => {
    const { browser, url } = await scene()
    const res = await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(204)
    const gone = await browser.call('GET', url)
    expect(gone.statusCode).toBe(404)
  })

  it('refuses with 409 has_documents when documents point to the client', async () => {
    const { browser, url, id } = await scene()
    await ctx.owner.query('insert into public.test_client_documents (client_id) values ($1)', [id])
    const res = await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'has_documents' })
    const still = await browser.call('GET', url)
    expect(still.statusCode).toBe(200)
  })

  it('a stale ETag is 412 and a missing one 428', async () => {
    const { browser, url } = await scene()
    const stale = await browser.call('DELETE', url, { headers: { 'if-match': '"9"' } })
    expect(stale.statusCode).toBe(412)
    const missing = await browser.call('DELETE', url)
    expect(missing.statusCode).toBe(428)
    expect((await browser.call('GET', url)).statusCode).toBe(200)
  })

  it('needs clients.delete: clients.update is not enough', async () => {
    const { browser, url } = await scene(['clients.view', 'clients.create', 'clients.update'])
    const res = await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(403)
    expect((await browser.call('GET', url)).statusCode).toBe(200)
  })

  it('without a session is 401', async () => {
    const { base, id } = await scene()
    const anonymous = new Browser(ctx.app)
    const res = await anonymous.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"1"' } })
    expect(res.statusCode).toBe(401)
  })
})
