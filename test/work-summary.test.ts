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

const ALL: Permission[] = ['reports.view', 'employees.view', 'vehicles.view']

interface Summary {
  hours: string
  days: number
  cost: string | null
  sites: {
    site: { id: string; name: string; code: string | null }
    hours: string
    days: number
    cost: string | null
    first_date: string
    last_date: string
  }[]
}

/** A company with two sites, two employees (one without hourly cost) and a vehicle. */
async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows.map((r) => r.id)
  const [villa = '', condo = ''] = await one(
    `insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-1'),
       ($1, 'Condominio', null) returning id`,
  )
  const [verdi = '', bassi = ''] = await one(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2850), ($1, 'Anna', 'Bassi', null) returning id`,
  )
  const [digger = ''] = await one(
    `insert into public.vehicles (company_id, name, kind, plate, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', null, 4500) returning id`,
  )
  /** A daily report with hours of Verdi, Bassi and the digger (0 = none). */
  const report = async (
    site: string,
    date: string,
    status: string,
    hours: { verdi?: string; bassi?: string; digger?: string },
  ) => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date, status)
       values ($1, $2, $3, $4) returning id`,
      [company.id, site, date, status],
    )
    const id = rows[0]?.id ?? ''
    let position = 0
    for (const [employee, h] of [
      [verdi, hours.verdi],
      [bassi, hours.bassi],
    ] as const) {
      if (!h) continue
      await ctx.owner.query(
        `insert into public.daily_report_labor
           (company_id, report_id, employee_id, hours, position) values ($1, $2, $3, $4, $5)`,
        [company.id, id, employee, h, position++],
      )
    }
    if (hours.digger) {
      await ctx.owner.query(
        `insert into public.daily_report_vehicles
           (company_id, report_id, vehicle_id, hours, position) values ($1, $2, $3, $4, 0)`,
        [company.id, id, digger, hours.digger],
      )
    }
  }
  return { browser, company, villa, condo, verdi, bassi, digger, report, slug: company.slug }
}

const employeeUrl = (slug: string, id: string, query = '') =>
  `/api/companies/${slug}/employees/${id}/work-summary${query}`
const vehicleUrl = (slug: string, id: string, query = '') =>
  `/api/companies/${slug}/vehicles/${id}/work-summary${query}`

describe('ore di dipendenti e mezzi per cantiere', () => {
  it('somma ore, giorni e costo per cantiere, dal cantiere con più ore', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8', digger: '3.5' })
    await s.report(s.villa, '2026-10-02', 'submitted', { verdi: '7.5' })
    await s.report(s.condo, '2026-10-02', 'draft', { verdi: '1', bassi: '8' })
    await s.report(s.condo, '2026-09-30', 'approved', { verdi: '0.33' })
    await s.report(s.condo, '2026-10-05', 'approved', { verdi: '10', digger: '2' })

    const res = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(res.statusCode).toBe(200)
    const body = res.json<Summary>()
    // 26.83 hours × 28.50 = 764.655; rounded per report line: 228 + 213.75 + 28.50 + 9.41 + 285
    expect(body).toEqual({
      hours: '26.83',
      days: 4,
      cost: '764.66',
      sites: [
        {
          site: { id: s.villa, name: 'Villetta', code: 'C-1' },
          hours: '15.50',
          days: 2,
          cost: '441.75',
          first_date: '2026-10-01',
          last_date: '2026-10-02',
        },
        {
          site: { id: s.condo, name: 'Condominio', code: null },
          hours: '11.33',
          days: 3,
          cost: '322.91',
          first_date: '2026-09-30',
          last_date: '2026-10-05',
        },
      ],
    })

    const vehicle = await s.browser.call('GET', vehicleUrl(s.slug, s.digger))
    expect(vehicle.statusCode).toBe(200)
    expect(vehicle.json<Summary>()).toMatchObject({
      hours: '5.50',
      days: 2,
      cost: '247.50',
      sites: [
        { site: { id: s.villa }, hours: '3.50', cost: '157.50' },
        { site: { id: s.condo }, hours: '2.00', cost: '90.00' },
      ],
    })
  })

  it('filtra per periodo e stato, con estremi compresi', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '8' })
    await s.report(s.villa, '2026-10-31', 'draft', { verdi: '4' })
    await s.report(s.condo, '2026-11-01', 'approved', { verdi: '6' })

    const october = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[from]=2026-10-01&filter[to]=2026-10-31'),
    )
    expect(october.json<Summary>()).toMatchObject({ hours: '12.00', days: 2, cost: '342.00' })
    expect(october.json<Summary>().sites).toHaveLength(1)

    const approved = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[status]=approved'),
    )
    expect(approved.json<Summary>()).toMatchObject({ hours: '14.00', days: 2 })
    expect(approved.json<Summary>().sites.map((x) => x.site.id)).toEqual([s.villa, s.condo])
  })

  it('senza costo orario il costo è null; senza ore risponde a zero', async () => {
    const s = await scene()
    await s.report(s.villa, '2026-10-01', 'approved', { bassi: '8' })
    const res = await s.browser.call('GET', employeeUrl(s.slug, s.bassi))
    expect(res.json<Summary>()).toMatchObject({
      hours: '8.00',
      cost: null,
      sites: [{ hours: '8.00', cost: null }],
    })

    const nothing = await s.browser.call(
      'GET',
      employeeUrl(s.slug, s.verdi, '?filter[from]=2027-01-01'),
    )
    expect(nothing.json<Summary>()).toEqual({ hours: '0.00', days: 0, cost: '0.00', sites: [] })
  })

  it('rifiuta filtri non validi con 422', async () => {
    const s = await scene()
    const res = await s.browser.call(
      'GET',
      employeeUrl(
        s.slug,
        s.verdi,
        '?filter[from]=2026-11-10&filter[to]=2026-11-01&filter[status]=boh',
      ),
    )
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors).sort()).toEqual([
      'filter[status]',
      'filter[to]',
    ])
    const bad = await s.browser.call('GET', vehicleUrl(s.slug, s.digger, '?filter[from]=ieri'))
    expect(bad.statusCode).toBe(422)
  })

  it('non mostra dipendenti e mezzi di un’altra azienda', async () => {
    const s = await scene()
    const other = await scene()
    await other.report(other.villa, '2026-10-01', 'approved', { verdi: '8', digger: '8' })
    expect((await s.browser.call('GET', employeeUrl(s.slug, other.verdi))).statusCode).toBe(404)
    expect((await s.browser.call('GET', vehicleUrl(s.slug, other.digger))).statusCode).toBe(404)
    // Its own employee does not see the hours of the other company either.
    await s.report(s.villa, '2026-10-01', 'approved', { verdi: '2' })
    const own = await s.browser.call('GET', employeeUrl(s.slug, s.verdi))
    expect(own.json<Summary>().hours).toBe('2.00')
  })

  it('404 senza il permesso della scheda o per un id inesistente, 403 senza reports.view', async () => {
    const noCard = await scene(['reports.view'])
    expect(
      (await noCard.browser.call('GET', employeeUrl(noCard.slug, noCard.verdi))).statusCode,
    ).toBe(404)
    expect(
      (await noCard.browser.call('GET', vehicleUrl(noCard.slug, noCard.digger))).statusCode,
    ).toBe(404)
    const noReports = await scene(['employees.view', 'vehicles.view'])
    expect(
      (await noReports.browser.call('GET', employeeUrl(noReports.slug, noReports.verdi)))
        .statusCode,
    ).toBe(403)
    expect(
      (await noReports.browser.call('GET', vehicleUrl(noReports.slug, noReports.digger)))
        .statusCode,
    ).toBe(403)
    const s = await scene()
    const missing = '0b8f6a52-3c1e-4d7a-9f20-6f1b2c3d4e5f'
    expect((await s.browser.call('GET', employeeUrl(s.slug, missing))).statusCode).toBe(404)
    expect((await s.browser.call('GET', employeeUrl(s.slug, 'non-un-id'))).statusCode).toBe(404)
  })

  it('401 senza sessione', async () => {
    const s = await scene()
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', employeeUrl(s.slug, s.verdi))).statusCode).toBe(401)
  })
})
