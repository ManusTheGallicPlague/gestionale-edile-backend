import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import { Browser, Fixtures, clientBody, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['clients.view', 'clients.create', 'clients.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Ufficio', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/clients` }
}

const vat = (first10: string) => `${first10}${partitaIvaCheckDigit(first10)}`

const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

interface Client {
  kind: string
  name: string
  vat_number: string | null
  city: string | null
  country: string
  phone: string | null
}

async function clients(browser: Browser, base: string) {
  const res = await browser.call('GET', `${base}?per_page=100&sort=name`)
  return res.json<{ data: Client[] }>().data
}

describe('client import', () => {
  it('adds every client of the file, checked like a new client', async () => {
    const s = await scene()
    const file =
      'Ragione sociale;Tipo;P.IVA;Codice fiscale;Città;Telefono;Paese\r\n' +
      `Alfa Costruzioni S.r.l.;;${vat('0123456780')};;Bergamo;'+39 035 555;\r\n` +
      'Mario Esempio;privato;;RSSMRA80A01H501U;Roma;;IT\r\n' +
      `Comune di Esempio;Ente pubblico;${vat('0000000001')};;;;\r\n`
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 3 })
    expect(await clients(s.browser, s.base)).toEqual([
      expect.objectContaining({
        name: 'Alfa Costruzioni S.r.l.',
        kind: 'company',
        city: 'Bergamo',
        country: 'IT',
        phone: '+39 035 555',
      }),
      expect.objectContaining({ name: 'Comune di Esempio', kind: 'public_body' }),
      expect.objectContaining({ name: 'Mario Esempio', kind: 'person', vat_number: null }),
    ])
  })

  it('reimports its own export into another company', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, { body: clientBody({ phone: '+39 011 555' }) })
    const exported = await s.browser.call('GET', `${s.base}/export`)
    const other = await scene()
    const res = await other.browser.call('POST', `${other.base}/import`, {
      body: exported.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(res.json()).toEqual({ created: 1 })
    const [copy] = await clients(other.browser, other.base)
    const [source] = await clients(s.browser, s.base)
    const fields = (c: Client | undefined) => ({ ...c, id: 0, created_at: 0, updated_at: 0 })
    expect(fields(copy)).toEqual(fields(source))
  })

  it('changes nothing when a row is wrong, duplicates included', async () => {
    const s = await scene()
    const taken = vat('0123456780')
    await s.browser.call('POST', s.base, { body: clientBody({ vat_number: taken }) })
    const file =
      'nome;tipo;partita iva;email\n' +
      `Buona;impresa;${vat('0000000002')};\n` +
      `Già presente;impresa;${taken};\n` +
      `;impresa;${vat('0000000003')};\n` +
      `Strana;cooperativa;${vat('0000000004')};\n` +
      `Ripetuta;impresa;${vat('0000000002')};non-una-email\n` +
      `Errata;impresa;01234567890;\n`
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(errors).sort()).toEqual(['row.4', 'row.5', 'row.6', 'row.7'])
    expect(errors['row.5']).toEqual(['tipo: azienda, persona o ente pubblico.'])
    expect(errors['row.4']?.[0]).toMatch(/^nome: /)
    expect(errors['row.7']?.[0]).toMatch(/^partita IVA: /)
    expect((await clients(s.browser, s.base)).map((c) => c.name)).toEqual(['Edil Prova S.r.l.'])

    // Duplicates are found only once the rows are valid: then on their row, nothing saved.
    const dup =
      'nome;partita iva\n' +
      `Nuova;${vat('0000000005')}\n` +
      `Già presente;${taken}\n` +
      `Ripetuta;${vat('0000000005')}\n`
    const second = await s.browser.call('POST', `${s.base}/import`, csv(dup))
    expect(second.statusCode).toBe(422)
    expect(second.json<{ errors: unknown }>().errors).toEqual({
      'row.3': ['partita IVA: Esiste già un cliente con questa partita IVA.'],
      'row.4': ['partita IVA: Esiste già un cliente con questa partita IVA.'],
    })
    expect(await clients(s.browser, s.base)).toHaveLength(1)

    for (const [body, message] of [
      ['citta;partita iva\nBergamo;x\n', 'nome'],
      ['nome\n\n', 'non ha clienti'],
    ] as const) {
      const bad = await s.browser.call('POST', `${s.base}/import`, csv(body))
      expect(bad.statusCode).toBe(422)
      expect(bad.json<{ errors: { file: string[] } }>().errors.file[0]).toContain(message)
    }
  })

  it('needs clients.create, the CSRF token and a CSV body', async () => {
    const viewer = await scene(['clients.view'])
    const denied = await viewer.browser.call('POST', `${viewer.base}/import`, csv('nome\nAlfa\n'))
    expect(denied.statusCode).toBe(403)
    const s = await scene()
    const noCsrf = await s.browser.call('POST', `${s.base}/import`, {
      ...csv('nome\nAlfa\n'),
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    const json = await s.browser.call('POST', `${s.base}/import`, { body: { name: 'Alfa' } })
    expect(json.statusCode).toBe(415)
    expect(await clients(s.browser, s.base)).toEqual([])
  })
})
