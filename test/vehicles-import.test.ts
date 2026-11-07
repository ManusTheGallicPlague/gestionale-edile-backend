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

const ALL: Permission[] = ['vehicles.view', 'vehicles.create', 'vehicles.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Ufficio', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/vehicles` }
}

const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

interface Vehicle {
  name: string
  kind: string
  plate: string | null
  hourly_cost: string | null
  active: boolean
}

async function vehicles(browser: Browser, base: string) {
  const res = await browser.call('GET', `${base}?per_page=100&sort=name`)
  return res.json<{ data: Vehicle[] }>().data
}

describe('vehicle import', () => {
  it('adds the vehicles with kinds, plates and Italian amounts', async () => {
    const s = await scene()
    const file =
      'Nome;Tipo;Targa;Marca e modello;Costo orario;In uso\n' +
      'Furgone;Automezzo;ab 123-cd;Modello X;"12,50";Sì\n' +
      'Escavatore;Macchina operatrice;;;1.045,00;no\n' +
      'Betoniera;attrezzatura;;;;\n' +
      'Camion;;EF456GH;;;\n'
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 4 })
    expect(await vehicles(s.browser, s.base)).toEqual([
      expect.objectContaining({ name: 'Betoniera', kind: 'equipment', active: true }),
      expect.objectContaining({ name: 'Camion', kind: 'vehicle', plate: 'EF456GH' }),
      expect.objectContaining({
        name: 'Escavatore',
        kind: 'machine',
        hourly_cost: '1045.00',
        active: false,
      }),
      expect.objectContaining({ name: 'Furgone', plate: 'AB123CD', hourly_cost: '12.50' }),
    ])

    // Its own export goes into another company unchanged.
    const exported = await s.browser.call('GET', `${s.base}/export`)
    const other = await scene()
    const again = await other.browser.call('POST', `${other.base}/import`, {
      body: exported.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(again.json()).toEqual({ created: 4 })
    const strip = (list: Vehicle[]) =>
      list.map((x) => ({ ...x, id: 0, created_at: 0, updated_at: 0 }))
    expect(strip(await vehicles(other.browser, other.base))).toEqual(
      strip(await vehicles(s.browser, s.base)),
    )
  })

  it('changes nothing when a row is wrong, duplicates included', async () => {
    const s = await scene()
    const file =
      'nome;tipo;targa;costo orario;in uso\n' +
      'Buono;;;;\n' +
      'Strano;gru volante;;;\n' +
      'Caro;;;dieci;\n' +
      'Incerto;;;;forse\n' +
      ';;AB-CD-EF-GH-IJ-KL;;\n'
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(errors).toEqual({
      'row.3': ['tipo: Automezzo, Macchina operatrice oppure Attrezzatura.'],
      'row.4': ['costo orario: importo non valido (es. 45,00).'],
      'row.5': ['in uso: sì oppure no.'],
      'row.6': [
        'nome: Il nome è obbligatorio.',
        'targa: Targa non valida: solo lettere e cifre, al massimo 10.',
      ],
    })

    const dup = 'nome;targa\nUno;AB123CD\nDue;ab 123 cd\n'
    const second = await s.browser.call('POST', `${s.base}/import`, csv(dup))
    expect(second.statusCode).toBe(422)
    expect(second.json<{ errors: unknown }>().errors).toEqual({
      'row.3': ['targa: Esiste già un mezzo con questa targa.'],
    })
    expect(await vehicles(s.browser, s.base)).toEqual([])
  })

  it('keeps each company to itself', async () => {
    const a = await scene()
    const b = await scene()
    const file = 'nome;targa\nFurgone;AB123CD\n'
    expect((await a.browser.call('POST', `${a.base}/import`, csv(file))).statusCode).toBe(200)
    // The same plate in another company is fine.
    expect((await b.browser.call('POST', `${b.base}/import`, csv(file))).statusCode).toBe(200)
    const cross = await b.browser.call('POST', `${a.base}/import`, csv('nome\nX\n'))
    expect(cross.statusCode).toBe(404)
    expect(await vehicles(a.browser, a.base)).toHaveLength(1)
  })

  it('needs vehicles.create, the CSRF token and a CSV body', async () => {
    const viewer = await scene(['vehicles.view'])
    const denied = await viewer.browser.call('POST', `${viewer.base}/import`, csv('nome\nA\n'))
    expect(denied.statusCode).toBe(403)
    const s = await scene()
    const noCsrf = await s.browser.call('POST', `${s.base}/import`, {
      ...csv('nome\nA\n'),
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    const json = await s.browser.call('POST', `${s.base}/import`, { body: { name: 'A' } })
    expect(json.statusCode).toBe(415)
    expect(await vehicles(s.browser, s.base)).toEqual([])
  })
})
