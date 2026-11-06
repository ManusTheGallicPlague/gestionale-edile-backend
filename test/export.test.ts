import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toCsv } from '../src/csv.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

describe('csv', () => {
  it('quotes separators and neutralises formulas', () => {
    const csv = toCsv(
      ['A', 'B'],
      [
        ['x;y', '=SOMMA(A1)'],
        ['"q"', null],
        [-5, '@a'],
      ],
    )
    expect(csv).toBe('\uFEFFA;B\r\n"x;y";\'=SOMMA(A1)\r\n"""q""";\r\n-5;\'@a\r\n')
  })
})

describe('clients export', () => {
  it('exports the filtered clients of the company, without pagination', async () => {
    const { company, user } = await fx.companyWithUser(['clients.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}/clients`
    const add = (companyId: string, name: string) =>
      ctx.owner.query(
        "insert into public.clients (company_id, kind, name) values ($1, 'person', $2)",
        [companyId, name],
      )
    for (const name of ['Zeta costruzioni', 'Alfa; Beta srl', '=HYPERLINK("x")']) {
      await add(company.id, name)
    }
    const other = await fx.company()
    await add(other.id, 'Segreto altrui')

    const res = await browser.call('GET', `${base}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toBe('attachment; filename="clienti.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[0]).toMatch(/^Tipo;Nome;Partita IVA;/)
    expect(lines.slice(1).map((l) => l.split(';')[1])).toEqual([
      '"\'=HYPERLINK(""x"")"',
      '"Alfa',
      'Zeta costruzioni',
    ])
    expect(lines[1]).toMatch(/^Privato;/)
    expect(res.body).not.toContain('Segreto altrui')

    const searched = await browser.call('GET', `${base}/export?search=zeta&sort=-name`)
    expect(searched.body.trim().split('\r\n')).toHaveLength(2)
    const bad = await browser.call('GET', `${base}/export?sort=boh`)
    expect(bad.statusCode).toBe(422)
  })

  it('needs clients.view and membership', async () => {
    const { company, user } = await fx.companyWithUser(['suppliers.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const url = `/api/companies/${company.slug}/clients/export`
    expect((await browser.call('GET', url)).statusCode).toBe(403)
    const stranger = await fx.companyWithUser(['clients.view'])
    const s = new Browser(ctx.app)
    await s.signIn(stranger.user.email)
    expect((await s.call('GET', url)).statusCode).toBe(404)
  })
})

describe('suppliers export', () => {
  it('exports the filtered suppliers, with categories and subcontractor flag', async () => {
    const { company, user } = await fx.companyWithUser(['suppliers.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    await ctx.owner.query(
      `insert into public.suppliers (company_id, name, categories, subcontractor)
       values ($1, 'Noli Rossi', '{rentals,materials}', false),
              ($1, 'Impianti Neri', '{subcontracting}', true)`,
      [company.id],
    )
    const other = await fx.company()
    await ctx.owner.query(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore altrui')",
      [other.id],
    )
    const url = `/api/companies/${company.slug}/suppliers/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="fornitori.csv"')
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^Impianti Neri;.*;Subappalto;Sì;$/)
    expect(lines[2]).toMatch(/^Noli Rossi;.*;Noli, Materiali;No;$/)
    expect(res.body).not.toContain('Fornitore altrui')
    const subs = await browser.call('GET', `${url}?filter[subcontractor]=true`)
    expect(subs.body.trim().split('\r\n')).toHaveLength(2)

    const blind = await fx.companyWithUser(['clients.view'])
    const b = new Browser(ctx.app)
    await b.signIn(blind.user.email)
    const forbidden = await b.call('GET', `/api/companies/${blind.company.slug}/suppliers/export`)
    expect(forbidden.statusCode).toBe(403)
    expect((await b.call('GET', url)).statusCode).toBe(404)
  })
})
