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
    name: 'Scuola elementare',
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

describe('CIG and CUP of a site', () => {
  it('are null when not sent, saved in capitals without spaces, unchanged when left out', async () => {
    const { browser, base } = await scene()
    const plain = await browser.call('POST', base, { body: siteBody() })
    expect(plain.statusCode).toBe(201)
    expect(plain.json()).toMatchObject({ cig: null, cup: null })

    const created = await browser.call('POST', base, {
      body: siteBody({ cig: ' 12345 abcde ', cup: 'b12c34000560007' }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ cig: '12345ABCDE', cup: 'B12C34000560007' })
    const url = `${base}/${created.json<{ id: string }>().id}`

    const kept = await browser.call('PUT', url, {
      body: siteBody({ name: 'Scuola media' }),
      headers: { 'if-match': '"1"' },
    })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toMatchObject({
      name: 'Scuola media',
      cig: '12345ABCDE',
      cup: 'B12C34000560007',
    })

    const cleared = await browser.call('PUT', url, {
      body: siteBody({ cig: '', cup: null }),
      headers: { 'if-match': '"2"' },
    })
    expect(cleared.json()).toMatchObject({ cig: null, cup: null })
    expect((await browser.call('GET', url)).json()).toMatchObject({ cig: null, cup: null })
  })

  it.each([
    ['a CIG too short', { cig: '123456789' }, 'cig'],
    ['a CIG too long', { cig: '12345678901' }, 'cig'],
    ['a CIG with a dash', { cig: '12345-6789' }, 'cig'],
    ['a CIG as a number', { cig: 1234567890 }, 'cig'],
    ['a CUP too short', { cup: 'B12C3400056000' }, 'cup'],
    ['a CUP with accents', { cup: 'B12C34000560è07' }, 'cup'],
    ['a CUP too long to read', { cup: 'B'.repeat(41) }, 'cup'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: siteBody(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
  })

  it('finds a site by CIG or CUP, only in the own company', async () => {
    const { browser, base, company } = await scene()
    const other = await scene()
    await ctx.owner.query(
      `insert into public.sites (company_id, name, status, cig, cup)
       values ($1, 'Palestra comunale', 'active', 'Z1A2B3C4D5', 'J91H22000110001'),
              ($1, 'Villetta privata', 'active', null, null),
              ($2, 'Palestra di un altro', 'active', 'Z1A2B3C4D5', 'J91H22000110001')`,
      [company.id, other.company.id],
    )
    for (const search of ['z1a2b3', 'J91H22000110001']) {
      const res = await browser.call('GET', `${base}?search=${search}`)
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { name: string }[] }>().data.map((s) => s.name)).toEqual([
        'Palestra comunale',
      ])
    }
    const csv = await browser.call('GET', `${base}/export?search=Z1A2B3C4D5`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Palestra comunale')
    expect(csv.body).toContain(';Z1A2B3C4D5;J91H22000110001')
    expect(csv.body).not.toContain('Palestra di un altro')
  })

  it('cannot be set without sites.update, nor on a site of another company', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: siteBody() })
    const id = created.json<{ id: string }>().id

    const reader = await scene(['sites.view'])
    const denied = await reader.browser.call('PUT', `${reader.base}/${id}`, {
      body: siteBody({ cig: '1234567890' }),
      headers: { 'if-match': '"1"' },
    })
    expect(denied.statusCode).toBe(403)

    const stranger = await scene()
    const hidden = await stranger.browser.call('PUT', `${stranger.base}/${id}`, {
      body: siteBody({ cig: '1234567890' }),
      headers: { 'if-match': '"1"' },
    })
    expect(hidden.statusCode).toBe(404)
    expect((await browser.call('GET', `${base}/${id}`)).json()).toMatchObject({ cig: null })
  })

  it('the database refuses a code in the wrong form', async () => {
    const { company } = await scene()
    for (const [cig, cup] of [
      ['12345abcde', null],
      [null, 'B12C3400056000'],
    ]) {
      await expect(
        ctx.owner.query(
          `insert into public.sites (company_id, name, status, cig, cup)
           values ($1, 'Errato', 'planned', $2, $3)`,
          [company.id, cig, cup],
        ),
      ).rejects.toThrow(/sites_c(ig|up)_check/)
    }
  })
})
