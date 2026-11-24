/**
 * The hourly cost of employees and vehicles is a cost: who sees them for the teams
 * (employees.view, vehicles.view) without costs.view must not see it anywhere, and saving
 * the form, which sends it back as null, must not wipe it out.
 */
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

const FOREMAN: Permission[] = [
  'employees.view',
  'employees.create',
  'employees.update',
  'vehicles.view',
  'vehicles.create',
  'vehicles.update',
  'reports.view',
  'sites.view',
]

/** A company with an employee and a vehicle with hourly costs, and an approved report. */
async function scene() {
  const { company, user: owner } = await fx.companyWithUser([...FOREMAN, 'costs.view'])
  const roleId = await fx.role(company.id, 'Capo cantiere', FOREMAN)
  const foreman = await fx.user()
  await fx.member(foreman.id, company.id, roleId)
  const boss = new Browser(ctx.app)
  await boss.signIn(owner.email)
  const browser = new Browser(ctx.app)
  await browser.signIn(foreman.email)
  const id = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const site = await id(`insert into public.sites (company_id, name) values ($1, 'Villetta')
    returning id`)
  const employee = await id(`insert into public.employees (company_id, first_name, last_name,
    hourly_cost_cents) values ($1, 'Luca', 'Verdi', 2850) returning id`)
  const vehicle = await id(`insert into public.vehicles (company_id, name, kind,
    hourly_cost_cents) values ($1, 'Escavatore', 'machine', 4500) returning id`)
  const report = await id(`insert into public.daily_reports (company_id, site_id, report_date,
    status) select $1, id, '2026-10-01', 'approved' from public.sites where company_id = $1
    returning id`)
  await ctx.owner.query(
    `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
     values ($1, $2, $3, 8, 0)`,
    [company.id, report, employee],
  )
  await ctx.owner.query(
    `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
     values ($1, $2, $3, 2, 0)`,
    [company.id, report, vehicle],
  )
  const base = `/api/companies/${company.slug}`
  return { browser, boss, base, site, employee, vehicle }
}

const employeeBody = (hourly_cost: string | null) => ({
  first_name: 'Luca',
  last_name: 'Verdi',
  tax_code: null,
  job_title: 'Muratore',
  phone: null,
  email: null,
  hired_on: null,
  hourly_cost,
  active: true,
  notes: null,
})

const vehicleBody = (hourly_cost: string | null) => ({
  name: 'Escavatore grande',
  kind: 'machine',
  plate: null,
  model: null,
  hourly_cost,
  active: true,
  notes: null,
})

describe('costo orario senza costs.view', () => {
  it('non arriva nelle schede, negli elenchi e nelle esportazioni dei dipendenti', async () => {
    const s = await scene()
    const url = `${s.base}/employees/${s.employee}`
    const card = await s.browser.call('GET', url)
    expect(card.json()).toMatchObject({ hourly_cost: null })
    const list = await s.browser.call('GET', `${s.base}/employees`)
    expect(list.json<{ data: { hourly_cost: unknown }[] }>().data[0]?.hourly_cost).toBeNull()
    const csv = await s.browser.call('GET', `${s.base}/employees/export`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).not.toContain('Costo orario')
    expect(csv.body).not.toContain('28,50')
    // Who has costs.view still sees it.
    expect((await s.boss.call('GET', url)).json()).toMatchObject({ hourly_cost: '28.50' })
    expect((await s.boss.call('GET', `${s.base}/employees/export`)).body).toContain('28,50')
  })

  it('non arriva nelle schede, negli elenchi e nelle esportazioni dei mezzi', async () => {
    const s = await scene()
    const url = `${s.base}/vehicles/${s.vehicle}`
    expect((await s.browser.call('GET', url)).json()).toMatchObject({ hourly_cost: null })
    const list = await s.browser.call('GET', `${s.base}/vehicles`)
    expect(list.json<{ data: { hourly_cost: unknown }[] }>().data[0]?.hourly_cost).toBeNull()
    const csv = await s.browser.call('GET', `${s.base}/vehicles/export`)
    expect(csv.body).not.toContain('Costo orario')
    expect(csv.body).not.toContain('45,00')
    expect((await s.boss.call('GET', url)).json()).toMatchObject({ hourly_cost: '45.00' })
  })

  it('non arriva nelle ore per cantiere di dipendenti e mezzi', async () => {
    const s = await scene()
    for (const path of [`employees/${s.employee}`, `vehicles/${s.vehicle}`]) {
      const summary = await s.browser.call('GET', `${s.base}/${path}/work-summary`)
      expect(summary.statusCode).toBe(200)
      const body = summary.json<{ cost: unknown; sites: { cost: unknown }[] }>()
      expect(body.cost).toBeNull()
      expect(body.sites.map((r) => r.cost)).toEqual([null])
      const csv = await s.browser.call('GET', `${s.base}/${path}/work-summary/export`)
      expect(csv.statusCode).toBe(200)
      expect(csv.body.split('\r\n')[0]).not.toContain('Costo')
      expect(csv.body).not.toMatch(/228,00|90,00/)
      const boss = await s.boss.call('GET', `${s.base}/${path}/work-summary`)
      expect(boss.json<{ cost: string }>().cost).toMatch(/^(228\.00|90\.00)$/)
    }
    const site = await s.browser.call('GET', `${s.base}/sites/${s.site}/work-summary`)
    expect(site.json<{ labor: { cost: unknown } }>().labor.cost).toBeNull()
  })

  it('salvare la scheda di un dipendente non cancella il costo orario', async () => {
    const s = await scene()
    const url = `${s.base}/employees/${s.employee}`
    const saved = await s.browser.call('PUT', url, {
      body: employeeBody(null),
      headers: { 'if-match': '"1"' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ job_title: 'Muratore', hourly_cost: null })
    // A value sent anyway is ignored as well.
    const again = await s.browser.call('PUT', url, {
      body: employeeBody('1.00'),
      headers: { 'if-match': '"2"' },
    })
    expect(again.statusCode).toBe(200)
    expect((await s.boss.call('GET', url)).json()).toMatchObject({ hourly_cost: '28.50' })
    // On create it stays empty.
    const created = await s.browser.call('POST', `${s.base}/employees`, {
      body: { ...employeeBody('30.00'), last_name: 'Neri' },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    expect((await s.boss.call('GET', `${s.base}/employees/${id}`)).json()).toMatchObject({
      hourly_cost: null,
    })
  })

  it('salvare la scheda di un mezzo non cancella il costo orario', async () => {
    const s = await scene()
    const url = `${s.base}/vehicles/${s.vehicle}`
    const saved = await s.browser.call('PUT', url, {
      body: vehicleBody(null),
      headers: { 'if-match': '"1"' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ name: 'Escavatore grande', hourly_cost: null })
    expect((await s.boss.call('GET', url)).json()).toMatchObject({ hourly_cost: '45.00' })
    const created = await s.browser.call('POST', `${s.base}/vehicles`, {
      body: { ...vehicleBody('12.00'), name: 'Furgone' },
    })
    const id = created.json<{ id: string }>().id
    expect((await s.boss.call('GET', `${s.base}/vehicles/${id}`)).json()).toMatchObject({
      hourly_cost: null,
    })
  })

  it("l'importazione senza costs.view non salva il costo orario", async () => {
    const s = await scene()
    const res = await s.browser.request('POST', `${s.base}/employees/import`, {
      body: 'cognome;nome;costo orario\r\nBianchi;Sara;31,00\r\n',
      headers: { 'content-type': 'text/csv' },
    })
    expect(res.statusCode).toBe(200)
    const list = await s.boss.call('GET', `${s.base}/employees?search=Bianchi`)
    expect(list.json<{ data: { hourly_cost: unknown }[] }>().data[0]?.hourly_cost).toBeNull()
  })
})
