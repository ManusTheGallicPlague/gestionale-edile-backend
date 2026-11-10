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

const ALL: Permission[] = [
  'reports.view',
  'reports.create',
  'reports.update',
  'reports.approve',
  'costs.view',
  'audit.view',
  'employees.view',
]

async function scene() {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    `insert into public.sites (company_id, name) values ($1, 'Villetta') returning id`,
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 2800), ($1, 'Anna', 'Bassi', 3000) returning id`,
    [company.id],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
     values ($1, 'Escavatore', 'machine', 4500) returning id`,
    [company.id],
  )
  return {
    browser,
    company,
    site: site.rows[0]?.id ?? '',
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    digger: vehicle.rows[0]?.id ?? '',
    slug: company.slug,
    base: `/api/companies/${company.slug}/daily-reports`,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

interface Report {
  id: string
  total_labor_hours: string
  total_overtime_hours: string
  labor: { employee_id: string; hours: string; overtime_hours: string }[]
}

function body(s: Scene, labor: unknown[], date = '2026-11-05') {
  return {
    site_id: s.site,
    date,
    weather: null,
    work_done: null,
    notes: null,
    labor,
    vehicles: [{ vehicle_id: s.digger, hours: '3', description: null }],
  }
}

describe('overtime in daily reports', () => {
  it('stores overtime inside the hours, with totals and without changing costs', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '10', overtime_hours: '2', description: null },
        // Absent and null are no overtime.
        { employee_id: s.bassi, hours: '7.5', description: null },
      ]),
    })
    expect(created.statusCode).toBe(201)
    const report = created.json<Report>()
    expect(report.total_labor_hours).toBe('17.50')
    expect(report.total_overtime_hours).toBe('2.00')
    expect(report.labor).toEqual([
      expect.objectContaining({ employee_id: s.verdi, hours: '10.00', overtime_hours: '2.00' }),
      expect.objectContaining({ employee_id: s.bassi, hours: '7.50', overtime_hours: '0.00' }),
    ])

    // The PDF shows it next to the employee and under the total, only where there is some.
    const pdf = (await s.browser.call('GET', `${s.base}/${report.id}/pdf`)).rawPayload.toString(
      'latin1',
    )
    expect(pdf).toContain('(Verdi Luca \\(straordinario 2\\))')
    expect(pdf).toContain('(Bassi Anna)')
    expect(pdf).toContain('(di cui straordinario)')

    // The CSV of the reports has it at the end.
    const csv = await s.browser.call('GET', `${s.base}/export`)
    expect(csv.body.trim().split('\r\n')[1]).toMatch(/;2,00$/)

    // The list has the total too.
    const list = await s.browser.call('GET', s.base)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Report[] }>().data[0]?.total_overtime_hours).toBe('2.00')

    // Changing only the overtime is a change of the labor rows, in the change log.
    const url = `${s.base}/${report.id}`
    const updated = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '10', overtime_hours: '1.5', description: null },
        { employee_id: s.bassi, hours: '7.5', overtime_hours: null, description: null },
      ]),
      headers: { 'If-Match': String(created.headers.etag) },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<Report>().total_overtime_hours).toBe('1.50')
    const log = await s.browser.call(
      'GET',
      `/api/companies/${s.slug}/audit-log?filter[entity]=daily_report&filter[field]=labor`,
    )
    expect(log.statusCode).toBe(200)
    expect(log.json<{ data: unknown[] }>().data).toHaveLength(1)

    // Saving the same hours again leaves no new entry.
    const same = await s.browser.call('PUT', url, {
      body: body(s, [
        { employee_id: s.verdi, hours: '10', overtime_hours: '1.50', description: null },
        { employee_id: s.bassi, hours: '7.5', description: null },
      ]),
      headers: { 'If-Match': String(updated.headers.etag) },
    })
    expect(same.statusCode).toBe(200)
    const again = await s.browser.call(
      'GET',
      `/api/companies/${s.slug}/audit-log?filter[entity]=daily_report&filter[field]=labor`,
    )
    expect(again.json<{ data: unknown[] }>().data).toHaveLength(1)

    // Costs stay on the hours at the hourly cost: 10 × 28 + 7.5 × 30 = 505 (approved only).
    await ctx.owner.query("update public.daily_reports set status = 'approved' where id = $1", [
      report.id,
    ])
    const summary = await s.browser.call(
      'GET',
      `/api/companies/${s.slug}/sites/${s.site}/cost-summary`,
    )
    expect(summary.statusCode).toBe(200)
    expect(summary.json<{ labor: { hours: string; amount: string } }>().labor).toMatchObject({
      hours: '17.50',
      amount: '505.00',
    })
  })

  it('rejects overtime that is not valid or above the hours', async () => {
    const s = await scene()
    for (const overtime of ['8.5', '-1', '1,5', 'due', 2, '25', '1.555']) {
      const res = await s.browser.call('POST', s.base, {
        body: body(s, [
          { employee_id: s.verdi, hours: '8', overtime_hours: overtime, description: null },
        ]),
      })
      expect(res.statusCode, String(overtime)).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['labor.0.overtime_hours'])
    }
    // Equal to the hours is allowed (a whole Sunday of overtime), zero too.
    const sunday = await s.browser.call('POST', s.base, {
      body: body(s, [
        { employee_id: s.verdi, hours: '6', overtime_hours: '6', description: null },
        { employee_id: s.bassi, hours: '6', overtime_hours: '0', description: null },
      ]),
    })
    expect(sunday.statusCode).toBe(201)
    expect(sunday.json<Report>().total_overtime_hours).toBe('6.00')
    // No overtime, no line under the total.
    const plain = await s.browser.call('POST', s.base, {
      body: body(s, [{ employee_id: s.verdi, hours: '8', description: null }], '2026-11-07'),
    })
    const pdf = await s.browser.call('GET', `${s.base}/${plain.json<Report>().id}/pdf`)
    expect(pdf.rawPayload.toString('latin1')).not.toContain('straordinario')
  })

  it('refuses overtime above the hours in the database too', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body(s, [{ employee_id: s.verdi, hours: '8', description: null }]),
    })
    expect(created.statusCode).toBe(201)
    await expect(
      ctx.owner.query(
        'update public.daily_report_labor set overtime_hours = 9 where employee_id = $1',
        [s.verdi],
      ),
    ).rejects.toThrow(/daily_report_labor_overtime_check/)
  })

  it('sums the overtime of the month in the monthly hours for the payroll', async () => {
    const s = await scene()
    for (const [date, overtime] of [
      ['2026-11-05', '2'],
      ['2026-11-06', '1.5'],
      ['2026-12-01', '3'],
    ] as const) {
      const res = await s.browser.call('POST', s.base, {
        body: body(
          s,
          [{ employee_id: s.verdi, hours: '10', overtime_hours: overtime, description: null }],
          date,
        ),
      })
      expect(res.statusCode).toBe(201)
    }
    const res = await s.browser.call('GET', `${s.base}/monthly-hours?month=2026-11`)
    expect(res.statusCode).toBe(200)
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n')
    const head = lines[0]?.split(';') ?? []
    expect(head.slice(-2)).toEqual(['Totale', 'Di cui straordinario'])
    const verdi = lines[1]?.split(';') ?? []
    expect(verdi.slice(0, 2)).toEqual(['Verdi', 'Luca'])
    expect(verdi[3 + 4]).toBe('10')
    expect(verdi.slice(-2)).toEqual(['20', '3,5'])
    // Another company sees none of it.
    const theirs = await scene()
    const other = await theirs.browser.call('GET', `${theirs.base}/monthly-hours?month=2026-11`)
    expect(other.body.replace('\uFEFF', '').trim().split('\r\n')).toHaveLength(1)
  })

  it('copies the overtime of the previous report in the proposal of today', async () => {
    const s = await scene()
    const today = (query: string) =>
      s.browser.call('GET', `${s.base}/today?site=${s.site}&${query}`)
    const created = await s.browser.call('POST', s.base, {
      body: body(
        s,
        [{ employee_id: s.verdi, hours: '9', overtime_hours: '1', description: null }],
        '2026-11-04',
      ),
    })
    expect(created.statusCode).toBe(201)
    const copied = await today('date=2026-11-05&copy_previous=true')
    expect(copied.statusCode).toBe(200)
    expect(copied.json<{ proposal: { labor: unknown[] } }>().proposal.labor).toEqual([
      { employee_id: s.verdi, hours: '9.00', overtime_hours: '1.00', description: null },
    ])
    // The usual team proposal has no overtime.
    await ctx.owner.query(
      'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
      [s.company.id, s.site, s.bassi],
    )
    const plain = await today('date=2026-11-05')
    expect(plain.statusCode).toBe(200)
    expect(plain.json<{ proposal: { labor: unknown[] } }>().proposal.labor).toEqual([
      { employee_id: s.bassi, hours: '8.00', overtime_hours: '0.00', description: null },
    ])
  })
})
