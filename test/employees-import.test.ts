import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { codiceFiscaleCheckLetter } from '../src/clients/tax-ids.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = ['employees.view', 'employees.create', 'employees.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Ufficio', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, base: `/api/companies/${company.slug}/employees` }
}

const cf = (first15: string) => `${first15}${codiceFiscaleCheckLetter(first15)}`
const csv = (text: string) => ({ body: text, headers: { 'content-type': 'text/csv' } })

interface Employee {
  first_name: string
  last_name: string
  tax_code: string | null
  hired_on: string | null
  hourly_cost: string | null
  active: boolean
}

async function employees(browser: Browser, base: string) {
  const res = await browser.call('GET', `${base}?per_page=100&sort=last_name`)
  return res.json<{ data: Employee[] }>().data
}

describe('employee import', () => {
  it('adds the employees with Italian dates and amounts', async () => {
    const s = await scene()
    const file =
      'Cognome;Nome;Codice fiscale;Mansione;Assunzione;Costo orario;Attivo;Ferie annue\n' +
      `Rossi;Mario;${cf('RSSMRA80A01H501')};Muratore;01/03/2020;"28,50";Sì;26\n` +
      `Bianchi;Luca;;Manovale;2021-09-15;1.234,00;no;0\n` +
      'Verdi;Anna;;;;;;\n'
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 3 })
    expect(await employees(s.browser, s.base)).toEqual([
      expect.objectContaining({
        last_name: 'Bianchi',
        hired_on: '2021-09-15',
        hourly_cost: '1234.00',
        active: false,
        annual_leave_days: 0,
      }),
      expect.objectContaining({
        last_name: 'Rossi',
        tax_code: 'RSSMRA80A01H501U',
        hired_on: '2020-03-01',
        hourly_cost: '28.50',
        active: true,
        annual_leave_days: 26,
      }),
      expect.objectContaining({
        last_name: 'Verdi',
        hourly_cost: null,
        active: true,
        annual_leave_days: null,
      }),
    ])

    // Its own export goes into another company unchanged.
    const exported = await s.browser.call('GET', `${s.base}/export`)
    const other = await scene()
    const again = await other.browser.call('POST', `${other.base}/import`, {
      body: exported.rawPayload,
      headers: { 'content-type': 'text/csv' },
    })
    expect(again.json()).toEqual({ created: 3 })
    const strip = (list: Employee[]) =>
      list.map((x) => ({ ...x, id: 0, created_at: 0, updated_at: 0 }))
    expect(strip(await employees(other.browser, other.base))).toEqual(
      strip(await employees(s.browser, s.base)),
    )
  })

  it('changes nothing when a row is wrong, duplicates included', async () => {
    const s = await scene()
    const file =
      'cognome;nome;codice fiscale;assunzione;costo orario;attivo;ferie\n' +
      'Buono;Uno;;;;;\n' +
      'Data;Due;;31/02/2020;;;\n' +
      'Costo;Tre;;;-5;;\n' +
      'Stato;Quattro;;;;forse;\n' +
      ';Cinque;RSSMRA80A01H501A;;;;\n' +
      'Ferie;Sei;;;;;26,5\n' +
      'Ferie;Sette;;;;;400\n'
    const res = await s.browser.call('POST', `${s.base}/import`, csv(file))
    expect(res.statusCode).toBe(422)
    const errors = res.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(errors).sort()).toEqual([
      'row.3',
      'row.4',
      'row.5',
      'row.6',
      'row.7',
      'row.8',
    ])
    expect(errors['row.7']).toEqual(['ferie annue: un numero intero di giorni (es. 26).'])
    expect(errors['row.8']).toEqual(['ferie annue: Un numero intero di giorni da 0 a 366.'])
    expect(errors['row.3']?.[0]).toMatch(/^assunzione: /)
    expect(errors['row.4']).toEqual(['costo orario: importo non valido (es. 28,50).'])
    expect(errors['row.5']).toEqual(['attivo: sì oppure no.'])
    expect(errors['row.6']).toEqual([
      'cognome: Il cognome è obbligatorio.',
      'codice fiscale: Codice fiscale non valido.',
    ])

    const code = cf('BNCLCU85M10F205')
    const dup = 'cognome;nome;codice fiscale\n' + `Uno;A;${code}\n` + `Due;B;${code}\n`
    const second = await s.browser.call('POST', `${s.base}/import`, csv(dup))
    expect(second.statusCode).toBe(422)
    expect(second.json<{ errors: unknown }>().errors).toEqual({
      'row.3': ['codice fiscale: Esiste già un dipendente con questo codice fiscale.'],
    })
    const header = await s.browser.call('POST', `${s.base}/import`, csv('nome\nA\n'))
    expect(header.json<{ errors: unknown }>().errors).toEqual({
      file: ['Nella prima riga manca la colonna cognome.'],
    })
    expect(await employees(s.browser, s.base)).toEqual([])
  })

  it('does not see the tax codes of another company', async () => {
    const code = cf('VRDNNA90D50L219')
    const a = await scene()
    const b = await scene()
    const file = `cognome;nome;codice fiscale\nVerdi;Anna;${code}\n`
    expect((await a.browser.call('POST', `${a.base}/import`, csv(file))).statusCode).toBe(200)
    expect((await b.browser.call('POST', `${b.base}/import`, csv(file))).statusCode).toBe(200)
    // b cannot import into a's company.
    const cross = await b.browser.call('POST', `${a.base}/import`, csv('cognome;nome\nX;Y\n'))
    expect(cross.statusCode).toBe(404)
    expect(await employees(a.browser, a.base)).toHaveLength(1)
  })

  it('needs employees.create and a CSV body', async () => {
    const viewer = await scene(['employees.view'])
    const denied = await viewer.browser.call(
      'POST',
      `${viewer.base}/import`,
      csv('cognome;nome\nA;B\n'),
    )
    expect(denied.statusCode).toBe(403)
    const s = await scene()
    const noCsrf = await s.browser.call('POST', `${s.base}/import`, {
      ...csv('cognome;nome\nA;B\n'),
      csrf: false,
    })
    expect(noCsrf.statusCode).toBe(403)
    const json = await s.browser.call('POST', `${s.base}/import`, { body: { last_name: 'A' } })
    expect(json.statusCode).toBe(415)
  })
})
