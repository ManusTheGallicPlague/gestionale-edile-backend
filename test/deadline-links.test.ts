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
  'deadlines.view',
  'deadlines.create',
  'deadlines.update',
  'deadlines.delete',
  'sites.delete',
  'employees.delete',
  'vehicles.delete',
]

async function linked(companyId: string) {
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [companyId],
  )
  const employee = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Rossi') returning id",
    [companyId],
  )
  const vehicle = await ctx.owner.query<{ id: string }>(
    "insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle') returning id",
    [companyId],
  )
  return {
    siteId: site.rows[0]?.id ?? '',
    employeeId: employee.rows[0]?.id ?? '',
    vehicleId: vehicle.rows[0]?.id ?? '',
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return {
    browser,
    company,
    ...(await linked(company.id)),
    api: `/api/companies/${company.slug}`,
    base: `/api/companies/${company.slug}/deadlines`,
  }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Visita medica',
    due_on: '2026-12-10',
    kind: 'medical_check',
    amount: null,
    client_id: null,
    supplier_id: null,
    notes: null,
    recurrence: null,
    ...overrides,
  }
}

describe('deadlines linked to a site, an employee or a vehicle', () => {
  it('stores the links and returns them with the names', async () => {
    const s = await scene()
    const res = await s.browser.call('POST', s.base, {
      body: body({ site_id: s.siteId, employee_id: s.employeeId, vehicle_id: s.vehicleId }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      kind: 'medical_check',
      site_id: s.siteId,
      employee_id: s.employeeId,
      vehicle_id: s.vehicleId,
      site: { id: s.siteId, name: 'Villetta' },
      employee: { id: s.employeeId, name: 'Rossi Mario' },
      vehicle: { id: s.vehicleId, name: 'Furgone' },
    })
  })

  it('treats the links as optional: absent means none, also when updating', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body({ kind: 'training', employee_id: s.employeeId }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ site: null, vehicle: null, site_id: null })
    const url = `${s.base}/${created.json<{ id: string }>().id}`
    const updated = await s.browser.call('PUT', url, {
      body: body({ kind: 'training' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ employee_id: null, employee: null })
  })

  it('filters the list and the export by site, employee and vehicle', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, { body: body({ employee_id: s.employeeId }) })
    await s.browser.call('POST', s.base, {
      body: body({ title: 'Revisione', kind: 'vehicle', vehicle_id: s.vehicleId }),
    })
    await s.browser.call('POST', s.base, {
      body: body({ title: 'Permesso', kind: 'other', site_id: s.siteId }),
    })
    for (const [filter, id, title] of [
      ['employee', s.employeeId, 'Visita medica'],
      ['vehicle', s.vehicleId, 'Revisione'],
      ['site', s.siteId, 'Permesso'],
    ] as const) {
      const res = await s.browser.call('GET', `${s.base}?filter[${filter}]=${id}`)
      expect(res.statusCode).toBe(200)
      const list = res.json<{ data: { title: string }[]; meta: { total: number } }>()
      expect(list.meta.total).toBe(1)
      expect(list.data[0]?.title).toBe(title)
    }
    expect((await s.browser.call('GET', `${s.base}?filter[site]=nope`)).statusCode).toBe(422)
    const csv = await s.browser.call('GET', `${s.base}/export?filter[vehicle]=${s.vehicleId}`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Cantiere')
    expect(csv.body).toContain('Furgone')
    expect(csv.body).not.toContain('Permesso')
  })

  it('refuses a site, employee or vehicle of another company with 422', async () => {
    const s = await scene()
    const other = await fx.companyWithUser([])
    const theirs = await linked(other.company.id)
    for (const [field, id] of [
      ['site_id', theirs.siteId],
      ['employee_id', theirs.employeeId],
      ['vehicle_id', theirs.vehicleId],
    ] as const) {
      const res = await s.browser.call('POST', s.base, { body: body({ [field]: id }) })
      expect(res.statusCode).toBe(422)
      expect(res.json<{ errors: Record<string, string[]> }>().errors[field]).toBeDefined()
    }
    const res = await s.browser.call('POST', s.base, { body: body({ site_id: 'nope' }) })
    expect(res.statusCode).toBe(422)
  })

  it('copies the links into the next recurring deadline', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.base, {
      body: body({ recurrence: 'yearly', employee_id: s.employeeId }),
    })
    const url = `${s.base}/${created.json<{ id: string }>().id}`
    const done = await s.browser.call('POST', `${url}/complete`, {
      headers: { 'if-match': '"1"' },
    })
    expect(done.statusCode).toBe(200)
    const nextId = done.json<{ next_deadline_id: string }>().next_deadline_id
    const next = await s.browser.call('GET', `${s.base}/${nextId}`)
    expect(next.json()).toMatchObject({ due_on: '2027-12-10', employee_id: s.employeeId })
  })

  it('keeps a site, employee or vehicle with deadlines from being deleted (409)', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, {
      body: body({ site_id: s.siteId, employee_id: s.employeeId, vehicle_id: s.vehicleId }),
    })
    for (const url of [
      `${s.api}/sites/${s.siteId}`,
      `${s.api}/employees/${s.employeeId}`,
      `${s.api}/vehicles/${s.vehicleId}`,
    ]) {
      const res = await s.browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'has_documents' })
    }
  })

  it('does not stop the deletion of a whole company', async () => {
    const s = await scene()
    await s.browser.call('POST', s.base, {
      body: body({ site_id: s.siteId, employee_id: s.employeeId, vehicle_id: s.vehicleId }),
    })
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query('select 1 from public.deadlines where company_id = $1', [
      s.company.id,
    ])
    expect(left.rowCount).toBe(0)
  })
})
