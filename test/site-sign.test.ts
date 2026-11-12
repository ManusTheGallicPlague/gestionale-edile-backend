import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'
import type { Permission } from '../src/permissions.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function setup(permissions: Permission[]) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string, params: unknown[] = []) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id, ...params])).rows[0]?.id ?? ''
  await insert(
    `insert into public.company_profiles (company_id, legal_name, vat_number, street, city)
     values ($1, 'Edilizia Prova Srl', '01234567890', 'Via Roma 1', 'Treviso')`,
  )
  const customer = await insert(
    `insert into public.clients (company_id, kind, name)
     values ($1, 'company', 'Condominio Aurora') returning id`,
  )
  const site = await insert(
    `insert into public.sites (company_id, name, code, client_id, address, start_on, end_on,
       cig, cup, permit, works_director, safety_coordinator, prior_notice_on)
     values ($1, 'Rifacimento facciata', 'C-1/26', $2, 'Via Garibaldi 3, Treviso',
       '2026-03-02', '2026-09-30', '1234567890', 'J12B34000560007', 'SCIA n. 7/2026',
       'Arch. Paola Verdi', 'Geom. Luca Neri', '2026-02-20') returning id`,
    [customer],
  )
  const supplier = async (name: string, subcontractor: boolean) => {
    const id = await insert(
      `insert into public.suppliers (company_id, name, vat_number, subcontractor)
       values ($1, $2, $3, $4) returning id`,
      [name, subcontractor ? '09876543210' : null, subcontractor],
    )
    await insert(
      `insert into public.site_costs (company_id, site_id, supplier_id, cost_date, category,
         description, amount_cents) values ($1, $2, $3, '2026-10-01', 'subcontract', 'x', 777777)`,
      [site, id],
    )
  }
  await supplier('Ponteggi Alfa', true)
  await supplier('Calcestruzzi Beta', false)
  return { company, browser, site, url: `/api/companies/${company.slug}/sites/${site}/sign/pdf` }
}

describe('site sign PDF', () => {
  it('prints the site, the client, the company and the people of the site', async () => {
    const { browser, url } = await setup(['sites.view', 'suppliers.view'])
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('attachment; filename="cartello-C-1-26.pdf"')
    const text = res.rawPayload.toString('latin1')
    for (const part of [
      '(CARTELLO DI CANTIERE)',
      '(Rifacimento facciata)',
      '(Via Garibaldi 3, Treviso)',
      '(Condominio Aurora)',
      '(SCIA n. 7/2026)',
      'CIG 1234567890',
      'CUP J12B34000560007',
      '(Edilizia Prova Srl)',
      'P. IVA 01234567890',
      '(Arch. Paola Verdi)',
      '(Geom. Luca Neri)',
      '(20/02/2026)',
      '(02/03/2026)',
      '(30/09/2026)',
      '(IMPRESE SUBAPPALTATRICI)',
      'Ponteggi Alfa',
      'P. IVA 09876543210',
    ]) {
      expect(text).toContain(part)
    }
    // Only subcontractors, and no amounts.
    expect(text).not.toContain('Calcestruzzi Beta')
    expect(text).not.toContain('7777')
  })

  it('leaves blank lines for what is missing and no CIG or CUP', async () => {
    const { browser, site, url } = await setup(['sites.view', 'suppliers.view'])
    await ctx.owner.query(
      `update public.sites set code = null, client_id = null, permit = null, cig = null,
         cup = null, works_director = null, prior_notice_on = null where id = $1`,
      [site],
    )
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="cartello-cantiere.pdf"')
    const text = res.rawPayload.toString('latin1')
    expect(text).not.toContain('Condominio Aurora')
    expect(text).not.toContain('SCIA')
    expect(text).not.toContain('Codici dei lavori pubblici'.toUpperCase())
    expect(text).not.toContain('Arch. Paola Verdi')
    expect(text).toContain('(Geom. Luca Neri)')
    // Committente, titolo edilizio, direttore dei lavori and notifica preliminare.
    expect(text.split('(______').length - 1).toBe(4)
  })

  it('leaves out the subcontractors without suppliers.view', async () => {
    const { browser, url } = await setup(['sites.view'])
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    const text = res.rawPayload.toString('latin1')
    expect(text).toContain('(Rifacimento facciata)')
    expect(text).not.toContain('SUBAPPALTATRICI')
    expect(text).not.toContain('Ponteggi Alfa')
  })

  it('answers 404 without sites.view, for another company and for a bad id', async () => {
    const { company, site, url } = await setup(['sites.view'])
    // A member of the same company without sites.view.
    const roleId = await fx.role(company.id, 'Magazzino', ['suppliers.view'])
    const member = await fx.user()
    await fx.member(member.id, company.id, roleId)
    const plain = new Browser(ctx.app)
    await plain.signIn(member.email)
    expect((await plain.call('GET', url)).statusCode).toBe(404)

    const stranger = await fx.companyWithUser(['sites.view', 'suppliers.view'])
    const other = new Browser(ctx.app)
    await other.signIn(stranger.user.email)
    const base = `/api/companies/${stranger.company.slug}/sites`
    expect((await other.call('GET', `${base}/${site}/sign/pdf`)).statusCode).toBe(404)
    expect((await other.call('GET', `${base}/not-an-id/sign/pdf`)).statusCode).toBe(404)
    expect((await other.call('GET', url)).statusCode).toBe(404)
  })

  it('answers 401 without a session', async () => {
    const { url } = await setup(['sites.view'])
    const res = await new Browser(ctx.app).call('GET', url)
    expect(res.statusCode).toBe(401)
  })
})
