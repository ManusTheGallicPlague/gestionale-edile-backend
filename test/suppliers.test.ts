import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
  // Stands in for the documents that will link to suppliers ("on delete restrict").
  await ctx.owner.query(
    `create table if not exists public.test_supplier_documents (
       id serial primary key,
       supplier_id uuid not null references public.suppliers (id) on delete restrict
     )`,
  )
})
afterAll(() => ctx.close())

const ALL: Permission[] = [
  'suppliers.view',
  'suppliers.create',
  'suppliers.update',
  'suppliers.delete',
]

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

function supplierBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Laterizi di Prova S.r.l.',
    vat_number: newVat(),
    tax_code: null,
    email: 'ordini@laterizi.example.test',
    pec: null,
    phone: '011 555 9876',
    street: 'Via delle Fornaci 3',
    postal_code: '10121',
    city: 'Torino',
    province: 'TO',
    country: 'IT',
    categories: ['materials'],
    subcontractor: false,
    notes: null,
    ...overrides,
  }
}

async function signedIn(permissions: Permission[] = ALL) {
  const scene = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(scene.user.email)
  return { ...scene, browser, base: `/api/companies/${scene.company.slug}/suppliers` }
}

/** A supplier created through the API by a user with every permission. */
async function withSupplier(permissions: Permission[] = ALL, body = supplierBody()) {
  const scene = await signedIn(permissions)
  const ownerUser = await fx.user()
  await fx.member(ownerUser.id, scene.company.id, await fx.role(scene.company.id, 'Tutto', ALL))
  const ownerBrowser = new Browser(ctx.app)
  await ownerBrowser.signIn(ownerUser.email)
  const res = await ownerBrowser.call('POST', scene.base, { body })
  expect(res.statusCode).toBe(201)
  const id = res.json<{ id: string }>().id
  return { ...scene, id, url: `${scene.base}/${id}`, ownerBrowser }
}

type Listed = { data: { id: string; name: string }[]; meta: { total: number } }

describe('create', () => {
  it('creates a supplier with categories and the subcontractor flag', async () => {
    const { browser, base } = await signedIn()
    const vat = newVat()
    const res = await browser.call('POST', base, {
      body: supplierBody({
        vat_number: `IT ${vat}`,
        categories: ['subcontracting', 'materials', 'subcontracting'],
        subcontractor: true,
      }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers.etag).toBe('"1"')
    expect(res.json()).toMatchObject({
      vat_number: vat,
      categories: ['subcontracting', 'materials'],
      subcontractor: true,
      archived_at: null,
    })
  })

  it.each([
    ['an unknown category', { categories: ['cemento'] }, 'categories'],
    ['categories that are not a list', { categories: 'materials' }, 'categories'],
    ['a subcontractor flag that is not boolean', { subcontractor: 'sì' }, 'subcontractor'],
    ['an Italian supplier without ids', { vat_number: null, tax_code: null }, 'vat_number'],
    ['a wrong partita IVA', { vat_number: '01234567890' }, 'vat_number'],
    ['a missing field', { notes: undefined }, 'notes'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await signedIn()
    const body: Record<string, unknown> = supplierBody(overrides)
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]
    const res = await browser.call('POST', base, { body })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('a foreign supplier needs no Italian ids', async () => {
    const { browser, base } = await signedIn()
    const res = await browser.call('POST', base, {
      body: supplierBody({
        vat_number: 'DE123456789',
        country: 'DE',
        province: null,
        postal_code: '80331',
      }),
    })
    expect(res.statusCode).toBe(201)
  })

  it('the same partita IVA is refused in the same company', async () => {
    const { browser, base } = await signedIn()
    const body = supplierBody()
    expect((await browser.call('POST', base, { body })).statusCode).toBe(201)
    const again = await browser.call('POST', base, { body: { ...body, name: 'Altro' } })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({ errors: { vat_number: expect.any(Array) as unknown } })
  })

  it('needs suppliers.create, and clients permissions do not count', async () => {
    const { browser, base } = await signedIn(['suppliers.view', 'clients.view', 'clients.create'])
    const res = await browser.call('POST', base, { body: supplierBody() })
    expect(res.statusCode).toBe(403)
  })
})

describe('list', () => {
  it('filters by category, subcontractor and archive, and searches', async () => {
    const { browser, base } = await signedIn()
    for (const [name, categories, subcontractor] of [
      ['Gru Alte', ['rentals'], false],
      ['Elettrica Sud', ['subcontracting'], true],
      ['Cemento Nord', ['materials'], false],
    ] as const) {
      await browser.call('POST', base, {
        body: supplierBody({ name, categories: [...categories], subcontractor }),
      })
    }
    const names = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((s) => s.name)

    expect(await names('')).toEqual(['Cemento Nord', 'Elettrica Sud', 'Gru Alte'])
    expect(await names('?filter[category]=rentals')).toEqual(['Gru Alte'])
    expect(await names('?filter[subcontractor]=true')).toEqual(['Elettrica Sud'])
    expect(await names('?filter[subcontractor]=false&sort=-name')).toEqual([
      'Gru Alte',
      'Cemento Nord',
    ])
    expect(await names('?search=nord')).toEqual(['Cemento Nord'])
    expect(await names('?filter[archived]=true')).toEqual([])
  })

  it('filters by compliance documents, looking at the latest expiry of each kind', async () => {
    const { browser, base, company } = await signedIn()
    const ids: Record<string, string> = {}
    for (const name of ['Rinnovato', 'Scaduto', 'In scadenza', 'Lontano', 'Senza', 'Senza data']) {
      const res = await browser.call('POST', base, {
        body: supplierBody({ name, subcontractor: true, categories: ['subcontracting'] }),
      })
      ids[name] = res.json<{ id: string }>().id
    }
    const today = "(now() at time zone 'Europe/Rome')::date"
    const doc = (name: string, kind: string, offset: number | null) =>
      ctx.owner.query(
        `insert into public.supplier_documents (company_id, supplier_id, kind, expires_on)
         values ($1, $2, $3, case when $4::int is null then null else ${today} + $4::int end)`,
        [company.id, ids[name], kind, offset],
      )
    // An old DURC expired, a new one valid: fine. Insurance expiring today counts as expiring.
    await doc('Rinnovato', 'durc', -40)
    await doc('Rinnovato', 'durc', 80)
    await doc('Scaduto', 'durc', 60)
    await doc('Scaduto', 'insurance', -1)
    await doc('In scadenza', 'durc', 30)
    await doc('In scadenza', 'insurance', 0)
    await doc('Lontano', 'durc', 31)
    await doc('Senza data', 'durc', null)
    await doc('Senza data', 'chamber_extract', -5)
    // Another company's supplier with an expired DURC stays out.
    const other = await signedIn()
    const foreign = await other.browser.call('POST', other.base, { body: supplierBody() })
    await ctx.owner.query(
      `insert into public.supplier_documents (company_id, supplier_id, kind, expires_on)
       values ($1, $2, 'durc', ${today} - 1)`,
      [other.company.id, foreign.json<{ id: string }>().id],
    )
    const names = async (query: string) =>
      (await browser.call('GET', `${base}${query}`)).json<Listed>().data.map((s) => s.name)
    expect(await names('?filter[compliance]=expired')).toEqual(['Scaduto', 'Senza data'])
    expect(await names('?filter[compliance]=expiring')).toEqual(['In scadenza'])
    expect(await names('?filter[compliance]=no_valid_durc&filter[subcontractor]=true')).toEqual([
      'Senza',
    ])
    const csv = await browser.call('GET', `${base}/export?filter[compliance]=expired`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\r\n')).toHaveLength(3)
    expect((await browser.call('GET', `${base}/export?filter[compliance]=durc`)).statusCode).toBe(
      422,
    )

    // The dashboard counts the same, for subcontractors only and not archived ones.
    await browser.call('POST', base, { body: supplierBody({ name: 'Materiali' }) })
    const archived = await browser.call('POST', base, {
      body: supplierBody({ name: 'Archiviato', subcontractor: true }),
    })
    await ctx.owner.query('update public.suppliers set archived_at = now() where id = $1', [
      archived.json<{ id: string }>().id,
    ])
    const dashboard = `/api/companies/${company.slug}/dashboard`
    const d = await browser.call('GET', dashboard)
    expect(d.statusCode).toBe(200)
    expect(d.json<{ subcontractors: unknown }>().subcontractors).toEqual({
      expired: 2,
      expiring: 1,
      no_valid_durc: 1,
    })
    const blind = await signedIn(['clients.view'])
    await fx.member(
      blind.user.id,
      company.id,
      await fx.role(company.id, 'Senza fornitori', ['clients.view']),
    )
    const hidden = await blind.browser.call('GET', dashboard)
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json<{ subcontractors: unknown }>().subcontractors).toBeNull()
  })

  it('refuses wrong filters with 422', async () => {
    const { browser, base } = await signedIn()
    for (const query of [
      'filter[category]=cemento',
      'filter[subcontractor]=forse',
      'filter[archived]=1',
      'filter[compliance]=scaduto',
      'sort=vat_number',
    ]) {
      const res = await browser.call('GET', `${base}?${query}`)
      expect(res.statusCode, query).toBe(422)
    }
  })

  it('without suppliers.view answers 403', async () => {
    const { browser, base } = await signedIn(['clients.view'])
    expect((await browser.call('GET', base)).statusCode).toBe(403)
  })
})

describe('read, update, archive, delete', () => {
  it('reads and updates with If-Match; a stale ETag is 412, a missing one 428', async () => {
    const { browser, url } = await withSupplier()
    const read = await browser.call('GET', url)
    expect(read.statusCode).toBe(200)
    expect(read.headers.etag).toBe('"1"')

    const body = supplierBody({ name: 'Nuovo nome', vat_number: newVat() })
    const updated = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ name: 'Nuovo nome' })

    const stale = await browser.call('PUT', url, { body, headers: { 'if-match': '"1"' } })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({ code: 'stale_record' })
    const missing = await browser.call('PUT', url, { body })
    expect(missing.statusCode).toBe(428)
  })

  it('without suppliers.view a single supplier is 404, not 403', async () => {
    const { browser, url } = await withSupplier(['clients.view'])
    expect((await browser.call('GET', url)).statusCode).toBe(404)
  })

  it('archives and restores', async () => {
    const { browser, base, url, id } = await withSupplier()
    const archived = await browser.call('POST', `${url}/archive`, {
      headers: { 'if-match': '"1"' },
    })
    expect(archived.statusCode).toBe(200)
    expect(archived.json<{ archived_at: string | null }>().archived_at).not.toBeNull()
    const active = (await browser.call('GET', base)).json<Listed>()
    expect(active.data.map((s) => s.id)).not.toContain(id)
    const onlyArchived = (await browser.call('GET', `${base}?filter[archived]=true`)).json<Listed>()
    expect(onlyArchived.data.map((s) => s.id)).toEqual([id])

    const restored = await browser.call('POST', `${url}/restore`, {
      headers: { 'if-match': '"2"' },
    })
    expect(restored.json()).toMatchObject({ archived_at: null })
  })

  it('deletes without documents, refuses with 409 when documents point to it', async () => {
    const free = await withSupplier()
    const del = await free.browser.call('DELETE', free.url, { headers: { 'if-match': '"1"' } })
    expect(del.statusCode).toBe(204)
    expect((await free.browser.call('GET', free.url)).statusCode).toBe(404)

    const linked = await withSupplier()
    await ctx.owner.query('insert into public.test_supplier_documents (supplier_id) values ($1)', [
      linked.id,
    ])
    const refused = await linked.browser.call('DELETE', linked.url, {
      headers: { 'if-match': '"1"' },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'has_documents' })
  })

  it('needs suppliers.update to archive and suppliers.delete to delete', async () => {
    const { browser, url } = await withSupplier(['suppliers.view'])
    const archive = await browser.call('POST', `${url}/archive`, {
      headers: { 'if-match': '"1"' },
    })
    expect(archive.statusCode).toBe(403)
    const del = await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
    expect(del.statusCode).toBe(403)
  })

  it('a supplier of another company is 404 everywhere and stays untouched', async () => {
    const mine = await signedIn()
    const theirs = await withSupplier()
    const url = `${mine.base}/${theirs.id}`
    const headers = { 'if-match': '"1"' }
    expect((await mine.browser.call('GET', url)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('PUT', url, { body: supplierBody(), headers })).statusCode,
    ).toBe(404)
    expect((await mine.browser.call('POST', `${url}/archive`, { headers })).statusCode).toBe(404)
    expect((await mine.browser.call('DELETE', url, { headers })).statusCode).toBe(404)
    const untouched = await theirs.browser.call('GET', theirs.url)
    expect(untouched.headers.etag).toBe('"1"')
  })

  it('without a session everything is 401', async () => {
    const { base } = await signedIn()
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', base)).statusCode).toBe(401)
  })
})
