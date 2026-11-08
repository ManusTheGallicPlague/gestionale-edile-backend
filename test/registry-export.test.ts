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

async function signedIn(permissions: Permission[]) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { company, browser }
}

const lines = (body: string) => body.replace('﻿', '').trim().split('\r\n')

describe('sites, employees and vehicles export', () => {
  it('exports the sites with translated status, Italian dates and budget', async () => {
    const { company, browser } = await signedIn(['sites.view'])
    await ctx.owner.query(
      `insert into public.sites (company_id, code, name, status, start_on, end_on, budget_cents)
       values ($1, 'C-1', 'Villetta', 'active', '2026-11-09', '2027-03-31', 8500050),
              ($1, null, '=Tetto', 'planned', null, null, null)`,
      [company.id],
    )
    const url = `/api/companies/${company.slug}/sites/export`
    const res = await browser.call('GET', `${url}?sort=name`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="cantieri.csv"')
    expect(lines(res.body)).toEqual([
      'Codice;Nome;Cliente;Indirizzo;Stato;Inizio;Fine prevista;Budget;Note',
      ";'=Tetto;;;Da iniziare;;;;",
      'C-1;Villetta;;;In corso;09/11/2026;31/03/2027;85000,50;',
    ])
    expect(lines((await browser.call('GET', `${url}?filter[status]=active`)).body)).toHaveLength(2)
    expect((await browser.call('GET', `${url}?filter[status]=boh`)).statusCode).toBe(422)
  })

  it('exports the employees with hourly cost and status', async () => {
    const { company, browser } = await signedIn(['employees.view'])
    await ctx.owner.query(
      `insert into public.employees (company_id, first_name, last_name, job_title, hired_on,
         hourly_cost_cents, active)
       values ($1, 'Luca', 'Verdi', 'Muratore', '2020-03-02', 2850, true),
              ($1, 'Anna', 'Bassi', null, null, null, false)`,
      [company.id],
    )
    await ctx.owner.query(
      "update public.employees set annual_leave_days = 26, annual_permit_hours = 88 where company_id = $1 and last_name = 'Verdi'",
      [company.id],
    )
    const url = `/api/companies/${company.slug}/employees/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="dipendenti.csv"')
    expect(lines(res.body)).toEqual([
      'Cognome;Nome;Codice fiscale;Mansione;Telefono;Email;Assunzione;Costo orario;Attivo;Note;Ferie annue;Permessi annui',
      'Bassi;Anna;;;;;;;No;;;',
      'Verdi;Luca;;Muratore;;;02/03/2020;28,50;Sì;;26;88',
    ])
    expect(lines((await browser.call('GET', `${url}?filter[active]=true`)).body)).toHaveLength(2)
  })

  it('exports the vehicles with translated kind', async () => {
    const { company, browser } = await signedIn(['vehicles.view'])
    await ctx.owner.query(
      `insert into public.vehicles (company_id, name, kind, plate, hourly_cost_cents)
       values ($1, 'Furgone', 'vehicle', 'AB123CD', 1500), ($1, 'Gru', 'machine', null, null)`,
      [company.id],
    )
    const url = `/api/companies/${company.slug}/vehicles/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="mezzi.csv"')
    expect(lines(res.body)).toEqual([
      'Nome;Tipo;Targa;Marca e modello;Costo orario;In uso;Note',
      'Furgone;Automezzo;AB123CD;;15,00;Sì;',
      'Gru;Macchina operatrice;;;;Sì;',
    ])
  })

  it('needs the view permission and stays in its company', async () => {
    const { company, browser } = await signedIn(['clients.view'])
    for (const resource of ['sites', 'employees', 'vehicles']) {
      const res = await browser.call('GET', `/api/companies/${company.slug}/${resource}/export`)
      expect(res.statusCode).toBe(403)
    }
    const other = await signedIn(['sites.view'])
    await ctx.owner.query("insert into public.sites (company_id, name) values ($1, 'Altrui')", [
      company.id,
    ])
    const res = await other.browser.call('GET', `/api/companies/${other.company.slug}/sites/export`)
    expect(res.body).not.toContain('Altrui')
    const foreign = await other.browser.call('GET', `/api/companies/${company.slug}/sites/export`)
    expect(foreign.statusCode).toBe(404)
  })
})
