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

const ALL: Permission[] = ['vehicles.view', 'vehicles.update']

async function vehicleOf(companyId: string, name = 'Escavatore') {
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.vehicles (company_id, name, kind) values ($1, $2, 'machine') returning id",
    [companyId, name],
  )
  return rows[0]?.id ?? ''
}

async function supplierOf(companyId: string, name = 'Officina Rossi') {
  const { rows } = await ctx.owner.query<{ id: string }>(
    'insert into public.suppliers (company_id, name) values ($1, $2) returning id',
    [companyId, name],
  )
  return rows[0]?.id ?? ''
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const vehicle = await vehicleOf(company.id)
  const base = `/api/companies/${company.slug}/vehicles/${vehicle}/maintenances`
  return { browser, company, vehicle, base }
}

const job = (overrides: Record<string, unknown> = {}) => ({
  performed_on: '2026-10-15',
  kind: 'service',
  description: 'Tagliando 500 ore',
  supplier_id: null,
  amount: '450.5',
  meter_reading: 500,
  notes: null,
  ...overrides,
})

type Maintenance = {
  id: string
  performed_on: string
  kind: string
  amount: string | null
  supplier: { id: string; name: string } | null
}
type List = { data: Maintenance[]; total_amount: string }

describe('maintenance of vehicles', () => {
  it('creates, lists newest first with the total, updates and deletes', async () => {
    const { browser, company, base } = await scene()
    const empty = await browser.call('GET', base)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [], total_amount: '0.00' })

    const supplier = await supplierOf(company.id)
    const first = await browser.call('POST', base, { body: job({ supplier_id: supplier }) })
    expect(first.statusCode).toBe(201)
    expect(first.headers.etag).toBe('"1"')
    expect(first.json()).toMatchObject({
      performed_on: '2026-10-15',
      amount: '450.50',
      meter_reading: 500,
      supplier: { id: supplier, name: 'Officina Rossi' },
    })
    const second = await browser.call('POST', base, {
      body: job({ performed_on: '2026-11-02', kind: 'repair', amount: '0.1', meter_reading: null }),
    })
    expect(second.statusCode).toBe(201)
    const third = await browser.call('POST', base, {
      body: job({ performed_on: '2026-01-10', kind: 'tires', amount: null }),
    })
    expect(third.json<Maintenance>().amount).toBeNull()

    const list = await browser.call('GET', base)
    const body = list.json<List>()
    expect(body.data.map((m) => m.performed_on)).toEqual(['2026-11-02', '2026-10-15', '2026-01-10'])
    // 450.50 + 0.10 in cents, the one without amount counts zero.
    expect(body.total_amount).toBe('450.60')

    const period = await browser.call(
      'GET',
      `${base}?filter[from]=2026-10-01&filter[to]=2026-10-31`,
    )
    expect(period.json<List>().data.map((m) => m.performed_on)).toEqual(['2026-10-15'])
    expect(period.json<List>().total_amount).toBe('450.50')

    const id = first.json<Maintenance>().id
    const updated = await browser.call('PUT', `${base}/${id}`, {
      body: job({ kind: 'inspection', supplier_id: null, amount: '99.99' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ kind: 'inspection', supplier: null, amount: '99.99' })
    const stale = await browser.call('PUT', `${base}/${id}`, {
      body: job(),
      headers: { 'if-match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    const missing = await browser.call('PUT', `${base}/${id}`, { body: job() })
    expect(missing.statusCode).toBe(428)

    expect(
      (await browser.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(412)
    expect(
      (await browser.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"2"' } }))
        .statusCode,
    ).toBe(204)
    expect(
      (await browser.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"2"' } }))
        .statusCode,
    ).toBe(404)
    expect((await browser.call('GET', base)).json<List>().data).toHaveLength(2)
  })

  it('refuses wrong input under each field, without writing', async () => {
    const { browser, base } = await scene()
    const cases: [Record<string, unknown>, string][] = [
      [job({ performed_on: '2026-02-30' }), 'performed_on'],
      [job({ performed_on: null }), 'performed_on'],
      [job({ kind: 'wash' }), 'kind'],
      [job({ description: '  ' }), 'description'],
      [job({ description: 'x'.repeat(301) }), 'description'],
      [job({ amount: 450.5 }), 'amount'],
      [job({ amount: '-1' }), 'amount'],
      [job({ amount: '1,50' }), 'amount'],
      [job({ meter_reading: 1.5 }), 'meter_reading'],
      [job({ meter_reading: -1 }), 'meter_reading'],
      [job({ meter_reading: '500' }), 'meter_reading'],
      [job({ supplier_id: 'abc' }), 'supplier_id'],
      [job({ notes: 'x'.repeat(2001) }), 'notes'],
      [job({ extra: 1 }), 'extra'],
      // Cents are not accepted from outside: only the amount in euros.
      [job({ amount_cents: '100' }), 'amount_cents'],
    ]
    for (const [body, field] of cases) {
      const res = await browser.call('POST', base, { body })
      expect(res.statusCode, field).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
    }
    const withoutNotes: Record<string, unknown> = job()
    delete withoutNotes.notes
    const res = await browser.call('POST', base, { body: withoutNotes })
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['notes'])
    const filter = await browser.call(
      'GET',
      `${base}?filter[from]=2026-12-01&filter[to]=2026-11-01`,
    )
    expect(filter.statusCode).toBe(422)
    expect((await browser.call('GET', base)).json<List>().data).toEqual([])
  })

  it('keeps other companies out: their vehicle, their supplier, their maintenance', async () => {
    const { browser, base } = await scene()
    const other = await fx.company('Altra impresa')
    const theirSupplier = await supplierOf(other.id, 'Officina loro')
    const res = await browser.call('POST', base, { body: job({ supplier_id: theirSupplier }) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['supplier_id'])

    const theirVehicle = await vehicleOf(other.id, 'Gru loro')
    await ctx.owner.query(
      `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind, description)
       values ($1, $2, '2026-10-01', 'repair', 'Loro')`,
      [other.id, theirVehicle],
    )
    const { rows } = await ctx.owner.query<{ id: string }>(
      'select id from public.vehicle_maintenances where vehicle_id = $1',
      [theirVehicle],
    )
    const theirId = rows[0]?.id ?? ''
    const theirBase = base.replace(/vehicles\/[^/]+/, `vehicles/${theirVehicle}`)
    expect((await browser.call('GET', theirBase)).statusCode).toBe(404)
    expect((await browser.call('POST', theirBase, { body: job() })).statusCode).toBe(404)
    // Their maintenance under my vehicle does not exist either.
    const put = await browser.call('PUT', `${base}/${theirId}`, {
      body: job(),
      headers: { 'if-match': '"1"' },
    })
    expect(put.statusCode).toBe(404)
    const del = await browser.call('DELETE', `${base}/${theirId}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(del.statusCode).toBe(404)
    const left = await ctx.owner.query('select 1 from public.vehicle_maintenances where id = $1', [
      theirId,
    ])
    expect(left.rowCount).toBe(1)
  })

  it('needs vehicles.view to read (404) and vehicles.update to write (403)', async () => {
    const reader = await scene(['vehicles.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    expect((await reader.browser.call('POST', reader.base, { body: job() })).statusCode).toBe(403)
    const none = await scene([])
    expect((await none.browser.call('GET', none.base)).statusCode).toBe(404)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', reader.base)).statusCode).toBe(401)
    expect(
      (await reader.browser.call('GET', reader.base.replace(/vehicles\/[^/]+/, 'vehicles/abc')))
        .statusCode,
    ).toBe(404)
  })

  it('goes with the vehicle; a workshop with maintenance is not deleted; the company is', async () => {
    const { browser, company, vehicle, base } = await scene([
      ...ALL,
      'vehicles.delete',
      'suppliers.delete',
    ])
    const supplier = await supplierOf(company.id)
    expect(
      (await browser.call('POST', base, { body: job({ supplier_id: supplier }) })).statusCode,
    ).toBe(201)
    const supplierDelete = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/suppliers/${supplier}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(supplierDelete.statusCode).toBe(409)
    const vehicleDelete = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/vehicles/${vehicle}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(vehicleDelete.statusCode).toBe(204)
    const left = await ctx.owner.query(
      'select 1 from public.vehicle_maintenances where company_id = $1',
      [company.id],
    )
    expect(left.rowCount).toBe(0)

    // A whole company with a maintenance by its own workshop goes away in one go.
    const another = await scene()
    const workshop = await supplierOf(another.company.id)
    await another.browser.call('POST', another.base, { body: job({ supplier_id: workshop }) })
    await ctx.owner.query('delete from public.companies where id = $1', [another.company.id])
    const gone = await ctx.owner.query(
      'select 1 from public.vehicle_maintenances where company_id = $1',
      [another.company.id],
    )
    expect(gone.rowCount).toBe(0)
  })
})
