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

async function vehicleOf(companyId: string, name = 'Furgone') {
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.vehicles (company_id, name, kind) values ($1, $2, 'vehicle') returning id",
    [companyId, name],
  )
  return rows[0]?.id ?? ''
}

async function supplierOf(companyId: string, name = 'Distributore Verdi') {
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
  const base = `/api/companies/${company.slug}/vehicles/${vehicle}/refuelings`
  return { browser, company, vehicle, base }
}

const fill = (overrides: Record<string, unknown> = {}) => ({
  refueled_on: '2026-10-15',
  liters: '45.2',
  amount: '80.1',
  meter_reading: 91200,
  supplier_id: null,
  notes: null,
  ...overrides,
})

type Refueling = {
  id: string
  refueled_on: string
  liters: string
  amount: string
  supplier: { id: string; name: string } | null
}
type List = { data: Refueling[]; total_liters: string; total_amount: string }

describe('refuelings of vehicles', () => {
  it('creates, lists newest first with the totals, updates and deletes', async () => {
    const { browser, company, base } = await scene()
    const empty = await browser.call('GET', base)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [], total_liters: '0.00', total_amount: '0.00' })

    const supplier = await supplierOf(company.id)
    const first = await browser.call('POST', base, { body: fill({ supplier_id: supplier }) })
    expect(first.statusCode).toBe(201)
    expect(first.headers.etag).toBe('"1"')
    expect(first.json()).toMatchObject({
      refueled_on: '2026-10-15',
      liters: '45.20',
      amount: '80.10',
      meter_reading: 91200,
      supplier: { id: supplier, name: 'Distributore Verdi' },
    })
    // 0.1 + 0.2 litres and euros: in floating point they would not make 0.3.
    await browser.call('POST', base, {
      body: fill({ refueled_on: '2026-11-02', liters: '0.1', amount: '0.1', meter_reading: null }),
    })
    await browser.call('POST', base, {
      body: fill({ refueled_on: '2026-01-10', liters: '0.2', amount: '0.2' }),
    })

    const body = (await browser.call('GET', base)).json<List>()
    expect(body.data.map((r) => r.refueled_on)).toEqual(['2026-11-02', '2026-10-15', '2026-01-10'])
    expect(body.total_liters).toBe('45.50')
    expect(body.total_amount).toBe('80.40')
    const small = await browser.call('GET', `${base}?filter[to]=2026-01-31`)
    expect(small.json()).toMatchObject({ total_liters: '0.20', total_amount: '0.20' })

    const period = await browser.call(
      'GET',
      `${base}?filter[from]=2026-10-01&filter[to]=2026-10-31`,
    )
    expect(period.json<List>().data.map((r) => r.refueled_on)).toEqual(['2026-10-15'])
    expect(period.json<List>().total_liters).toBe('45.20')

    const id = first.json<Refueling>().id
    const updated = await browser.call('PUT', `${base}/${id}`, {
      body: fill({ liters: '999999.99', amount: '0', supplier_id: null }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ liters: '999999.99', amount: '0.00', supplier: null })
    const stale = await browser.call('PUT', `${base}/${id}`, {
      body: fill(),
      headers: { 'if-match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    expect((await browser.call('PUT', `${base}/${id}`, { body: fill() })).statusCode).toBe(428)
    expect((await browser.call('DELETE', `${base}/${id}`)).statusCode).toBe(428)

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
      [fill({ refueled_on: '2026-02-30' }), 'refueled_on'],
      [fill({ refueled_on: null }), 'refueled_on'],
      [fill({ liters: 45.2 }), 'liters'],
      [fill({ liters: '0' }), 'liters'],
      [fill({ liters: '0.00' }), 'liters'],
      [fill({ liters: '-5' }), 'liters'],
      [fill({ liters: '45,2' }), 'liters'],
      [fill({ liters: '1.234' }), 'liters'],
      [fill({ liters: '1000000' }), 'liters'],
      [fill({ liters: null }), 'liters'],
      [fill({ amount: null }), 'amount'],
      [fill({ amount: 80.1 }), 'amount'],
      [fill({ amount: '-1' }), 'amount'],
      [fill({ amount: '1,50' }), 'amount'],
      [fill({ meter_reading: 1.5 }), 'meter_reading'],
      [fill({ meter_reading: -1 }), 'meter_reading'],
      [fill({ meter_reading: '500' }), 'meter_reading'],
      [fill({ supplier_id: 'abc' }), 'supplier_id'],
      [fill({ notes: 'x'.repeat(2001) }), 'notes'],
      [fill({ extra: 1 }), 'extra'],
      // Cents are not accepted from outside: only the amount in euros.
      [fill({ amount_cents: '100' }), 'amount_cents'],
    ]
    for (const [body, field] of cases) {
      const res = await browser.call('POST', base, { body })
      expect(res.statusCode, field).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors), field).toEqual([field])
    }
    const withoutNotes: Record<string, unknown> = fill()
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

  it('keeps other companies out: their vehicle, their supplier, their refueling', async () => {
    const { browser, base } = await scene()
    const other = await fx.company('Altra impresa')
    const theirSupplier = await supplierOf(other.id, 'Distributore loro')
    const res = await browser.call('POST', base, { body: fill({ supplier_id: theirSupplier }) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['supplier_id'])

    const theirVehicle = await vehicleOf(other.id, 'Camion loro')
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
       values ($1, $2, '2026-10-01', 50, 9000) returning id`,
      [other.id, theirVehicle],
    )
    const theirId = rows[0]?.id ?? ''
    const theirBase = base.replace(/vehicles\/[^/]+/, `vehicles/${theirVehicle}`)
    expect((await browser.call('GET', theirBase)).statusCode).toBe(404)
    expect((await browser.call('POST', theirBase, { body: fill() })).statusCode).toBe(404)
    // Their refueling under my vehicle does not exist either.
    const put = await browser.call('PUT', `${base}/${theirId}`, {
      body: fill(),
      headers: { 'if-match': '"1"' },
    })
    expect(put.statusCode).toBe(404)
    const del = await browser.call('DELETE', `${base}/${theirId}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(del.statusCode).toBe(404)
    const left = await ctx.owner.query(
      'select liters::text, amount_cents::text from public.vehicle_refuelings where id = $1',
      [theirId],
    )
    expect(left.rows).toEqual([{ liters: '50.00', amount_cents: '9000' }])
    // Their refueling does not count in my totals.
    expect((await browser.call('GET', base)).json()).toMatchObject({ total_liters: '0.00' })
  })

  it('exports the refuelings of all vehicles in CSV, with filters', async () => {
    const { browser, company, vehicle, base } = await scene()
    const station = await supplierOf(company.id, 'Distributore; Bianchi')
    const digger = await vehicleOf(company.id, 'Escavatore')
    await ctx.owner.query("update public.vehicles set plate = 'AB123CD' where id = $1", [vehicle])
    const diggerBase = base.replace(/vehicles\/[^/]+/, `vehicles/${digger}`)
    await browser.call('POST', base, { body: fill({ notes: '=1+1', supplier_id: station }) })
    await browser.call('POST', diggerBase, {
      body: fill({
        refueled_on: '2026-11-02',
        liters: '120',
        amount: '210.5',
        meter_reading: 1340,
      }),
    })
    await browser.call('POST', base, {
      body: fill({ refueled_on: '2025-12-20', liters: '0.5', amount: '1', meter_reading: null }),
    })
    const other = await scene()
    await other.browser.call('POST', other.base, { body: fill({ notes: 'Loro' }) })

    const url = `/api/companies/${company.slug}/vehicle-refuelings/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="rifornimenti.csv"')
    expect(res.body.replace('\ufeff', '').trim().split('\r\n')).toEqual([
      'Data;Mezzo;Targa;Litri;Spesa;Km o ore;Distributore;Note',
      '02/11/2026;Escavatore;;120,00;210,50;1340;;',
      `15/10/2026;Furgone;AB123CD;45,20;80,10;91200;"Distributore; Bianchi";'=1+1`,
      '20/12/2025;Furgone;AB123CD;0,50;1,00;;;',
    ])
    const filtered = await browser.call(
      'GET',
      `${url}?filter[from]=2026-01-01&filter[to]=2026-12-31&filter[vehicle]=${digger}`,
    )
    expect(filtered.body.replace('\ufeff', '').trim().split('\r\n')).toHaveLength(2)
    const bad = await browser.call('GET', `${url}?filter[vehicle]=abc&filter[from]=ieri`)
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors).sort()).toEqual([
      'filter[from]',
      'filter[vehicle]',
    ])
    const none = await scene([])
    expect(
      (
        await none.browser.call(
          'GET',
          `/api/companies/${none.company.slug}/vehicle-refuelings/export`,
        )
      ).statusCode,
    ).toBe(403)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })

  it('needs vehicles.view to read (404) and vehicles.update to write (403)', async () => {
    const reader = await scene(['vehicles.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    expect((await reader.browser.call('POST', reader.base, { body: fill() })).statusCode).toBe(403)
    const none = await scene([])
    expect((await none.browser.call('GET', none.base)).statusCode).toBe(404)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', reader.base)).statusCode).toBe(401)
    expect(
      (await reader.browser.call('GET', reader.base.replace(/vehicles\/[^/]+/, 'vehicles/abc')))
        .statusCode,
    ).toBe(404)
  })

  it('goes with the vehicle; a filling station with refuelings is not deleted; the company is', async () => {
    const { browser, company, vehicle, base } = await scene([
      ...ALL,
      'vehicles.delete',
      'suppliers.delete',
    ])
    const supplier = await supplierOf(company.id)
    expect(
      (await browser.call('POST', base, { body: fill({ supplier_id: supplier }) })).statusCode,
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
      'select 1 from public.vehicle_refuelings where company_id = $1',
      [company.id],
    )
    expect(left.rowCount).toBe(0)

    const another = await scene()
    const station = await supplierOf(another.company.id)
    await another.browser.call('POST', another.base, { body: fill({ supplier_id: station }) })
    await ctx.owner.query('delete from public.companies where id = $1', [another.company.id])
    const gone = await ctx.owner.query(
      'select 1 from public.vehicle_refuelings where company_id = $1',
      [another.company.id],
    )
    expect(gone.rowCount).toBe(0)
  })

  it('shows the last refueling in the vehicle card and in the list', async () => {
    const { browser, company, vehicle, base } = await scene()
    const card = `/api/companies/${company.slug}/vehicles/${vehicle}`
    const list = `/api/companies/${company.slug}/vehicles`
    type Card = { id: string; last_refueling: { id: string } | null }
    const last = async () => (await browser.call('GET', card)).json<Card>().last_refueling
    expect(await last()).toBeNull()

    const older = (
      await browser.call('POST', base, { body: fill({ refueled_on: '2026-10-01' }) })
    ).json<Refueling>()
    expect(await last()).toEqual({
      id: older.id,
      refueled_on: '2026-10-01',
      liters: '45.20',
      meter_reading: 91200,
    })
    // A refueling registered later but made earlier does not take its place.
    await browser.call('POST', base, { body: fill({ refueled_on: '2026-09-01' }) })
    expect(await last()).toMatchObject({ id: older.id })
    // Same day: the one registered last wins.
    const sameDay = (
      await browser.call('POST', base, {
        body: fill({ refueled_on: '2026-10-01', liters: '0.1', meter_reading: null }),
      })
    ).json<Refueling>()
    expect(await last()).toEqual({
      id: sameDay.id,
      refueled_on: '2026-10-01',
      liters: '0.10',
      meter_reading: null,
    })
    // The ETag of the vehicle does not change.
    expect((await browser.call('GET', card)).headers.etag).toBe('"1"')

    // Moving the older refueling forward makes it the last one.
    await browser.call('PUT', `${base}/${older.id}`, {
      body: fill({ refueled_on: '2026-10-20', liters: '60', meter_reading: 92000 }),
      headers: { 'if-match': '"1"' },
    })
    expect(await last()).toEqual({
      id: older.id,
      refueled_on: '2026-10-20',
      liters: '60.00',
      meter_reading: 92000,
    })

    // Another vehicle of the company and one of another company keep their own.
    const bare = await vehicleOf(company.id, 'Autocarro')
    const other = await fx.company('Altra impresa')
    const theirVehicle = await vehicleOf(other.id, 'Camion loro')
    await ctx.owner.query(
      `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
       values ($1, $2, '2026-12-01', 50, 9000)`,
      [other.id, theirVehicle],
    )
    const rows = (await browser.call('GET', `${list}?sort=name`)).json<{ data: Card[] }>().data
    expect(rows.map((v) => [v.id, v.last_refueling && v.last_refueling.id])).toEqual([
      [bare, null],
      [vehicle, older.id],
    ])

    // Sent in the body it is ignored; the vehicle is updated.
    const put = await browser.call('PUT', card, {
      body: {
        name: 'Furgone grande',
        kind: 'vehicle',
        plate: null,
        model: null,
        hourly_cost: null,
        active: true,
        notes: null,
        last_refueling: null,
      },
      headers: { 'if-match': '"1"' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json<Card>().last_refueling).toMatchObject({ id: older.id })

    await browser.call('DELETE', `${base}/${older.id}`, { headers: { 'if-match': '"2"' } })
    expect(await last()).toMatchObject({ id: sameDay.id })
  })
})
