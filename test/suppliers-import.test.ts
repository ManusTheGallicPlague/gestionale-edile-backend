import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['suppliers.view', 'suppliers.create', 'suppliers.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Ufficio', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/suppliers` }
}

const vat = (first10: string) => `${first10}${partitaIvaCheckDigit(first10)}`
const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

interface Supplier {
  name: string
  vat_number: string | null
  categories: string[]
  subcontractor: boolean
  country: string
}

async function suppliers(browser: Browser, base: string) {
  const res = await browser.call('GET', `${base}?per_page=100&sort=name`)
  return res.json<{ data: Supplier[] }>().data
}

describe('supplier import', () => {
  it('adds the suppliers with categories and the subcontractor flag', async () => {
    const s = await scene()
    const file =
      'Ragione sociale;Partita IVA;Categorie;Subappaltatore\n' +
      `Ferro Esempio S.r.l.;${vat('0123456780')};"Materiali, Noli";No\n` +
      `Scavi Esempio S.n.c.;${vat('0000000001')};subappalto;Sì\n` +
      `Servizi Esempio;${vat('0000000002')};;\n`
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 3 })
    expect(await suppliers(s.browser, s.base)).toEqual([
      expect.objectContaining({
        name: 'Ferro Esempio S.r.l.',
        categories: ['materials', 'rentals'],
        subcontractor: false,
        country: 'IT',
      }),
      expect.objectContaining({
        name: 'Scavi Esempio S.n.c.',
        categories: ['subcontracting'],
        subcontractor: true,
      }),
      expect.objectContaining({ name: 'Servizi Esempio', categories: [], subcontractor: false }),
    ])

    // Its own export goes into another company unchanged.
    const exported = await s.browser.call('GET', `${s.base}/export`)
    const other = await scene()
    const again = await other.browser.call('POST', `${other.base}/import`, {
      body: exported.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(again.json()).toEqual({ created: 3 })
    const strip = (list: Supplier[]) =>
      list.map((x) => ({ ...x, id: 0, created_at: 0, updated_at: 0 }))
    expect(strip(await suppliers(other.browser, other.base))).toEqual(
      strip(await suppliers(s.browser, s.base)),
    )
  })

  it('changes nothing when a row is wrong, duplicates included', async () => {
    const s = await scene()
    const file =
      'nome;partita iva;categorie;subappaltatore\n' +
      `Buono;${vat('0000000003')};materiali;no\n` +
      `Strano;${vat('0000000004')};cemento;no\n` +
      `Incerto;${vat('0000000005')};;forse\n` +
      `Errato;01234567890;;\n`
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(errors).sort()).toEqual(['row.3', 'row.4', 'row.5'])
    expect(errors['row.3']).toEqual(['categorie: «cemento» non è una categoria.'])
    expect(errors['row.5']?.[0]).toMatch(/^partita IVA: /)

    const dup = 'nome;partita iva\n' + `Uno;${vat('0000000006')}\n` + `Due;${vat('0000000006')}\n`
    const second = await s.browser.call('POST', `${s.base}/import`, csv(dup))
    expect(second.statusCode).toBe(422)
    expect(second.json<{ errors: unknown }>().errors).toEqual({
      'row.3': ['partita IVA: Esiste già un fornitore con questa partita IVA.'],
    })
    expect(await suppliers(s.browser, s.base)).toEqual([])
  })

  it('needs suppliers.create and a CSV body', async () => {
    const viewer = await scene(['suppliers.view'])
    const denied = await viewer.browser.call('POST', `${viewer.base}/import`, csv('nome\nA\n'))
    expect(denied.statusCode).toBe(403)
    const s = await scene()
    const json = await s.browser.call('POST', `${s.base}/import`, { body: { name: 'A' } })
    expect(json.statusCode).toBe(415)
  })
})
