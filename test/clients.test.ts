import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import { Browser, Fixtures, clientBody, startApp, unique, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL = ['clients.view', 'clients.create', 'clients.update'] as const

/** A fresh valid partita IVA, so tests never collide on uniqueness. */
function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

async function signedIn(permissions: readonly (typeof ALL)[number][] = ALL) {
  const scene = await fx.companyWithUser([...permissions])
  const browser = new Browser(ctx.app)
  await browser.signIn(scene.user.email)
  return { ...scene, browser, base: `/api/companies/${scene.company.slug}/clients` }
}

describe('create', () => {
  it('creates a client and answers 201 with ETag and normalized ids', async () => {
    const { browser, base } = await signedIn()
    const vat = newVat()
    const res = await browser.call('POST', base, {
      body: clientBody({
        vat_number: ` it ${vat.slice(0, 5)} ${vat.slice(5)} `,
        email: 'INFO@X.example.test',
      }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers.etag).toBe('"1"')
    expect(res.json()).toMatchObject({
      vat_number: vat,
      email: 'info@x.example.test',
      country: 'IT',
    })
  })

  it('requires every field, null when empty', async () => {
    const { browser, base } = await signedIn()
    const body: Record<string, unknown> = clientBody({ vat_number: newVat() })
    delete body.notes
    const res = await browser.call('POST', base, { body })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { notes: ['Campo mancante.'] } })
  })

  it.each([
    ['partita IVA with a wrong check digit', { vat_number: '01234567890' }, 'vat_number'],
    [
      'private person without codice fiscale',
      { kind: 'person', vat_number: null, tax_code: null },
      'tax_code',
    ],
    [
      'private person with a wrong codice fiscale',
      { kind: 'person', vat_number: null, tax_code: 'RSSMRA80A01H501X' },
      'tax_code',
    ],
    [
      'company without partita IVA nor codice fiscale',
      { vat_number: null, tax_code: null },
      'vat_number',
    ],
    ['email without domain', { email: 'info@' }, 'email'],
    ['codice destinatario of 5 characters', { sdi_code: 'ABC12' }, 'sdi_code'],
    ['Italian postal code of 4 digits', { postal_code: '1012' }, 'postal_code'],
    ['unknown kind', { kind: 'altro' }, 'kind'],
    ['empty name', { name: '   ' }, 'name'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await signedIn()
    const res = await browser.call('POST', base, {
      body: clientBody({ vat_number: newVat(), ...overrides }),
    })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it.each([
    [
      'a condominium with only a numeric codice fiscale',
      { vat_number: null, tax_code: '90000000001' },
    ],
    [
      'a private person with a valid codice fiscale',
      { kind: 'person', vat_number: null, tax_code: 'RSSMRA80A01H501U' },
    ],
    [
      'a public body with a 6-character codice destinatario',
      { kind: 'public_body', sdi_code: 'UFABCD' },
    ],
    [
      'a foreign client without Italian ids',
      { vat_number: null, tax_code: null, country: 'DE', postal_code: '10115', province: null },
    ],
  ])('accepts %s', async (_label, overrides) => {
    const { browser, base } = await signedIn()
    const res = await browser.call('POST', base, {
      body: clientBody({ vat_number: newVat(), ...overrides }),
    })
    expect(res.statusCode, res.body).toBe(201)
  })

  it('the same partita IVA is refused in the same company, allowed in another', async () => {
    const vat = newVat()
    const first = await signedIn()
    expect(
      (await first.browser.call('POST', first.base, { body: clientBody({ vat_number: vat }) }))
        .statusCode,
    ).toBe(201)
    const dup = await first.browser.call('POST', first.base, {
      body: clientBody({ vat_number: `IT${vat}` }),
    })
    expect(dup.statusCode).toBe(422)
    expect(dup.json()).toMatchObject({
      errors: { vat_number: ['Esiste già un cliente con questa partita IVA.'] },
    })
    const other = await signedIn()
    expect(
      (await other.browser.call('POST', other.base, { body: clientBody({ vat_number: vat }) }))
        .statusCode,
    ).toBe(201)
  })

  it('the same codice fiscale can be a private person and a sole trader', async () => {
    const { browser, base } = await signedIn()
    const cf = 'VRDGPP80A01L219M'
    const person = await browser.call('POST', base, {
      body: clientBody({ kind: 'person', vat_number: null, tax_code: cf }),
    })
    expect(person.statusCode, person.body).toBe(201)
    const trader = await browser.call('POST', base, {
      body: clientBody({ vat_number: newVat(), tax_code: cf }),
    })
    expect(trader.statusCode, trader.body).toBe(201)
    const again = await browser.call('POST', base, {
      body: clientBody({ kind: 'person', vat_number: null, tax_code: cf }),
    })
    expect(again.statusCode).toBe(422)
  })

  it('needs clients.create, and the CSRF token', async () => {
    const viewer = await signedIn(['clients.view'])
    const forbidden = await viewer.browser.call('POST', viewer.base, {
      body: clientBody({ vat_number: newVat() }),
    })
    expect(forbidden.statusCode).toBe(403)
    const owner = await signedIn()
    const noCsrf = await owner.browser.call('POST', owner.base, {
      body: clientBody({ vat_number: newVat() }),
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json()).toMatchObject({ code: 'csrf_invalid' })
  })
})

describe('list', () => {
  async function companyWithClients() {
    const scene = await signedIn()
    const names = ['Beta Costruzioni', 'alfa edilizia', 'Gamma Scavi', 'Mario Verdi']
    for (const name of names) {
      const body =
        name === 'Mario Verdi'
          ? clientBody({
              name,
              kind: 'person',
              vat_number: null,
              tax_code: 'VRDMRA80A01L219I',
              city: 'Asti',
            })
          : clientBody({ name, vat_number: newVat() })
      const res = await scene.browser.request('POST', scene.base, { body })
      expect(res.statusCode, res.body).toBe(201)
    }
    return scene
  }

  it('pages, sorts by name without caring about case, and counts', async () => {
    const { browser, base } = await companyWithClients()
    const res = await browser.call('GET', `${base}?per_page=2&page=2&sort=name`)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { name: string }[]; meta: object }>()
    expect(body.meta).toEqual({ total: 4, page: 2, per_page: 2 })
    expect(body.data.map((c) => c.name)).toEqual(['Gamma Scavi', 'Mario Verdi'])
    const desc = await browser.call('GET', `${base}?sort=-name&per_page=1`)
    expect(desc.json<{ data: { name: string }[] }>().data[0]?.name).toBe('Mario Verdi')
  })

  it('a page past the end is empty but keeps the total', async () => {
    const { browser, base } = await companyWithClients()
    const res = await browser.call('GET', `${base}?page=9`)
    expect(res.json()).toMatchObject({ data: [], meta: { total: 4, page: 9 } })
  })

  it('searches name, city and ids, and filters by kind', async () => {
    const { browser, base } = await companyWithClients()
    const search = await browser.call('GET', `${base}?search=ASTI`)
    expect(search.json<{ data: { name: string }[] }>().data.map((c) => c.name)).toEqual([
      'Mario Verdi',
    ])
    const people = await browser.call('GET', `${base}?filter[kind]=person`)
    expect(people.json<{ meta: { total: number } }>().meta.total).toBe(1)
    // % and _ are searched literally, not as wildcards
    const literal = await browser.call('GET', `${base}?search=%25`)
    expect(literal.json<{ meta: { total: number } }>().meta.total).toBe(0)
  })

  it.each([
    ['page=0'],
    ['per_page=101'],
    ['sort=email'],
    ['filter[kind]=altro'],
    ['page=1&page=2'],
  ])('refuses %s with 422', async (query) => {
    const { browser, base } = await signedIn()
    expect((await browser.call('GET', `${base}?${query}`)).statusCode).toBe(422)
  })

  it('without clients.view answers 403', async () => {
    const { browser, base } = await signedIn(['clients.create'])
    expect((await browser.call('GET', base)).statusCode).toBe(403)
  })
})

describe('isolation between companies', () => {
  it('another company, or one that does not exist, is 404', async () => {
    const mine = await signedIn()
    const theirs = await signedIn()
    const created = await theirs.browser.call('POST', theirs.base, {
      body: clientBody({ vat_number: newVat() }),
    })
    const id = created.json<{ id: string }>().id

    expect((await mine.browser.call('GET', theirs.base)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('GET', `/api/companies/non-esiste-${unique()}/clients`)).statusCode,
    ).toBe(404)
    // Their client id, through my company: not found either
    expect((await mine.browser.call('GET', `${mine.base}/${id}`)).statusCode).toBe(404)
    const put = await mine.browser.call('PUT', `${mine.base}/${id}`, {
      body: clientBody({ vat_number: newVat() }),
      headers: { 'if-match': '"1"' },
    })
    expect(put.statusCode).toBe(404)
    // And their client is untouched
    const check = await theirs.browser.call('GET', `${theirs.base}/${id}`)
    expect(check.headers.etag).toBe('"1"')
  })

  it('without a session everything is 401', async () => {
    const { base } = await signedIn()
    expect((await new Browser(ctx.app).call('GET', base)).statusCode).toBe(401)
  })
})

describe('read and update', () => {
  async function withClient(permissions: readonly (typeof ALL)[number][] = ALL) {
    const scene = await signedIn(permissions)
    // A second user of the same company, with every permission, creates the client
    const ownerBrowser = new Browser(ctx.app)
    const ownerUser = await fx.user()
    const roleId = await fx.role(scene.company.id, `Tutto ${unique()}`, [...ALL])
    await fx.member(ownerUser.id, scene.company.id, roleId)
    await ownerBrowser.signIn(ownerUser.email)
    const res = await ownerBrowser.call('POST', scene.base, {
      body: clientBody({ vat_number: newVat() }),
    })
    const id = res.json<{ id: string }>().id
    return { ...scene, id, url: `${scene.base}/${id}`, ownerBrowser }
  }

  it('reads one client with its ETag', async () => {
    const { browser, url, id } = await withClient()
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('"1"')
    expect(res.json()).toMatchObject({ id })
  })

  it('without clients.view a single client is 404, not 403', async () => {
    const { browser, url } = await withClient(['clients.create'])
    expect((await browser.call('GET', url)).statusCode).toBe(404)
  })

  it('an id that is not ours, or not an id at all, is 404', async () => {
    const { browser, base } = await withClient()
    expect(
      (await browser.call('GET', `${base}/00000000-0000-4000-8000-000000000000`)).statusCode,
    ).toBe(404)
    expect((await browser.call('GET', `${base}/non-un-id`)).statusCode).toBe(404)
  })

  it('updates with If-Match and returns the next ETag', async () => {
    const { browser, url } = await withClient()
    const res = await browser.call('PUT', url, {
      body: clientBody({ vat_number: newVat(), name: 'Nuovo nome S.r.l.' }),
      headers: { 'if-match': '"1"' },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers.etag).toBe('"2"')
    expect(res.json()).toMatchObject({ name: 'Nuovo nome S.r.l.' })
    const created = new Date(res.json<{ created_at: string }>().created_at)
    const updated = new Date(res.json<{ updated_at: string }>().updated_at)
    expect(updated.getTime()).toBeGreaterThanOrEqual(created.getTime())
  })

  it('a stale ETag is 412 and nothing is overwritten', async () => {
    const { browser, url, ownerBrowser } = await withClient()
    // Someone else saves first
    await ownerBrowser.call('PUT', url, {
      body: clientBody({ vat_number: newVat(), name: 'Salvato prima' }),
      headers: { 'if-match': '"1"' },
    })
    const late = await browser.call('PUT', url, {
      body: clientBody({ vat_number: newVat(), name: 'Arrivato tardi' }),
      headers: { 'if-match': '"1"' },
    })
    expect(late.statusCode).toBe(412)
    expect(late.json()).toMatchObject({ code: 'stale_record' })
    expect((await browser.call('GET', url)).json()).toMatchObject({ name: 'Salvato prima' })
  })

  it('without If-Match is 428', async () => {
    const { browser, url } = await withClient()
    const res = await browser.call('PUT', url, { body: clientBody({ vat_number: newVat() }) })
    expect(res.statusCode).toBe(428)
    expect(res.json()).toMatchObject({ code: 'precondition_required' })
  })

  it('needs clients.update', async () => {
    const { browser, url } = await withClient(['clients.view'])
    const res = await browser.call('PUT', url, {
      body: clientBody({ vat_number: newVat() }),
      headers: { 'if-match': '"1"' },
    })
    expect(res.statusCode).toBe(403)
  })
})
