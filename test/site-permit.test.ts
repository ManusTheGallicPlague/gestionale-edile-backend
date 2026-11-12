import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['sites.view', 'sites.create', 'sites.update']

function siteBody(overrides: Record<string, unknown> = {}) {
  return {
    code: null,
    name: 'Ristrutturazione condominio',
    client_id: null,
    address: null,
    status: 'planned',
    start_on: null,
    end_on: null,
    budget: null,
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/sites` }
}

const EMPTY = {
  permit: null,
  works_director: null,
  safety_coordinator: null,
  prior_notice_on: null,
}

const FILLED = {
  permit: 'Permesso di costruire n. 45/2026 del 12/03/2026',
  works_director: 'Ing. Mario Rossi, Ordine degli ingegneri n. 1234',
  safety_coordinator: 'Geom. Anna Bianchi',
  prior_notice_on: '2026-03-20',
}

describe('permit and people of a site', () => {
  it('are null when not sent, saved trimmed, unchanged when left out, cleared with null', async () => {
    const { browser, base } = await scene()
    const plain = await browser.call('POST', base, { body: siteBody() })
    expect(plain.statusCode).toBe(201)
    expect(plain.json()).toMatchObject(EMPTY)

    const created = await browser.call('POST', base, {
      body: siteBody({ ...FILLED, permit: `  ${FILLED.permit}  ` }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject(FILLED)
    const url = `${base}/${created.json<{ id: string }>().id}`

    const kept = await browser.call('PUT', url, {
      body: siteBody({ name: 'Ristrutturazione facciata' }),
      headers: { 'if-match': '"1"' },
    })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toMatchObject({ name: 'Ristrutturazione facciata', ...FILLED })

    const cleared = await browser.call('PUT', url, {
      body: siteBody({ permit: '', works_director: null, safety_coordinator: ' ' }),
      headers: { 'if-match': '"2"' },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ ...EMPTY, prior_notice_on: '2026-03-20' })

    const noNotice = await browser.call('PUT', url, {
      body: siteBody({ prior_notice_on: null }),
      headers: { 'if-match': '"3"' },
    })
    expect(noNotice.statusCode).toBe(200)
    expect((await browser.call('GET', url)).json()).toMatchObject(EMPTY)

    const list = await browser.call('GET', base)
    expect(list.statusCode).toBe(200)
  })

  it.each([
    ['a permit too long', { permit: 'x'.repeat(201) }, 'permit'],
    ['a works director as a number', { works_director: 12 }, 'works_director'],
    ['a coordinator too long', { safety_coordinator: 'x'.repeat(201) }, 'safety_coordinator'],
    ['a prior notice that is not a date', { prior_notice_on: '20/03/2026' }, 'prior_notice_on'],
    ['an impossible prior notice date', { prior_notice_on: '2026-02-30' }, 'prior_notice_on'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: siteBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
  })

  it('cannot be set without sites.update, nor on a site of another company', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: siteBody() })
    const id = created.json<{ id: string }>().id

    const reader = await scene(['sites.view'])
    const denied = await reader.browser.call('PUT', `${reader.base}/${id}`, {
      body: siteBody(FILLED),
      headers: { 'if-match': '"1"' },
    })
    expect(denied.statusCode).toBe(403)

    const stranger = await scene()
    const hidden = await stranger.browser.call('PUT', `${stranger.base}/${id}`, {
      body: siteBody(FILLED),
      headers: { 'if-match': '"1"' },
    })
    expect(hidden.statusCode).toBe(404)
    const read = await stranger.browser.call('GET', `${stranger.base}/${id}`)
    expect(read.statusCode).toBe(404)
    expect((await browser.call('GET', `${base}/${id}`)).json()).toMatchObject(EMPTY)
  })

  it('end the CSV of the sites, with the date of the prior notice in Italian', async () => {
    const { browser, base } = await scene()
    await browser.call('POST', base, { body: siteBody({ name: 'Con titolo', ...FILLED }) })
    await browser.call('POST', base, { body: siteBody({ name: 'Senza titolo' }) })
    const csv = await browser.call('GET', `${base}/export?sort=name`)
    expect(csv.statusCode).toBe(200)
    const rows = csv.body.trim().split('\r\n')
    expect(rows[0]).toMatch(
      /;CIG;CUP;Titolo edilizio;Direttore dei lavori;Coordinatore sicurezza;Notifica preliminare$/,
    )
    expect(rows[1]).toMatch(
      /^;Con titolo;.*;;;Permesso di costruire n\. 45\/2026 del 12\/03\/2026;Ing\. Mario Rossi, Ordine degli ingegneri n\. 1234;Geom\. Anna Bianchi;20\/03\/2026$/,
    )
    expect(rows[2]).toMatch(/^;Senza titolo;.*;;;;;;$/)
  })

  it('the database refuses a text too long', async () => {
    const { company } = await scene()
    await expect(
      ctx.owner.query(
        `insert into public.sites (company_id, name, status, permit)
         values ($1, 'Errato', 'planned', $2)`,
        [company.id, 'x'.repeat(201)],
      ),
    ).rejects.toThrow(/sites_permit_check/)
  })
})
