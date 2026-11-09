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

async function vehicleOf(companyId: string, name: string, kind: string, plate: string | null) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicles (company_id, name, kind, plate)
     values ($1, $2, $3, $4) returning id`,
    [companyId, name, kind, plate],
  )
  return rows[0]?.id ?? ''
}

async function refueling(
  companyId: string,
  vehicleId: string,
  on: string,
  liters: string,
  cents: number,
  meter: number | null = null,
) {
  const { rows } = await ctx.owner.query<{ id: string }>(
    `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters,
       amount_cents, meter_reading)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [companyId, vehicleId, on, liters, cents, meter],
  )
  return rows[0]?.id ?? ''
}

async function scene(permissions: Permission[] = ['vehicles.view']) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  return { browser, company, url: `/api/companies/${company.slug}/vehicle-refuelings` }
}

type Row = {
  id: string
  consumption: string | null
  vehicle: { id: string; name: string; plate: string | null }
}
type List = { data: Row[]; meta: unknown; total_liters: string; total_amount: string }

describe('refuelings of all the vehicles', () => {
  it('lists every vehicle newest first, a page at a time, with the totals of the filter', async () => {
    const { browser, company, url } = await scene()
    const van = await vehicleOf(company.id, 'Furgone', 'vehicle', 'AB123CD')
    const digger = await vehicleOf(company.id, 'Escavatore', 'machine', null)
    const first = await refueling(company.id, van, '2026-10-01', '40.10', 6000, 10000)
    // 50 litres over 500 km: 10.00 every 100 km.
    const second = await refueling(company.id, van, '2026-10-20', '50.20', 7550, 10500)
    const same = await refueling(company.id, digger, '2026-10-20', '0.10', 1)
    const latest = await refueling(company.id, digger, '2026-11-02', '0.20', 2)

    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    const list = res.json<List>()
    expect(list.data.map((r) => r.id)).toEqual([latest, same, second, first])
    expect(list.meta).toEqual({ total: 4, page: 1, per_page: 25 })
    // 40.10 + 50.20 + 0.10 + 0.20, without floating point.
    expect(list.total_liters).toBe('90.60')
    expect(list.total_amount).toBe('135.53')
    expect(list.data[2]).toMatchObject({
      consumption: '10.04',
      vehicle: { id: van, name: 'Furgone', plate: 'AB123CD' },
    })
    expect(list.data[3]?.consumption).toBeNull()

    const page = await browser.call('GET', `${url}?page=2&per_page=3`)
    expect(page.json<List>()).toMatchObject({
      meta: { total: 4, page: 2, per_page: 3 },
      total_liters: '90.60',
      total_amount: '135.53',
    })
    expect(page.json<List>().data.map((r) => r.id)).toEqual([first])

    const filtered = await browser.call(
      'GET',
      `${url}?filter[from]=2026-10-20&filter[to]=2026-10-20&filter[vehicle]=${digger}`,
    )
    expect(filtered.json<List>().data.map((r) => r.id)).toEqual([same])
    expect(filtered.json<List>()).toMatchObject({ total_liters: '0.10', total_amount: '0.01' })
  })

  it('searches notes, vehicle name and plate and the station, in the list and in the CSV', async () => {
    const { browser, company, url } = await scene()
    const other = await scene()
    const van = await vehicleOf(company.id, 'Furgone', 'vehicle', 'AB123CD')
    const digger = await vehicleOf(company.id, 'Escavatore', 'machine', null)
    const station = await ctx.owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Distributore Nord') returning id",
      [company.id],
    )
    const a = await refueling(company.id, van, '2026-10-01', '0.10', 10)
    const b = await refueling(company.id, van, '2026-10-02', '0.20', 20)
    const c = await refueling(company.id, digger, '2026-10-03', '7.00', 700)
    await ctx.owner.query(
      "update public.vehicle_refuelings set notes = 'Tanica di riserva' where id = $1",
      [c],
    )
    await ctx.owner.query('update public.vehicle_refuelings set supplier_id = $1 where id = $2', [
      station.rows[0]?.id,
      b,
    ])
    // Another company with a vehicle of the same name and the same notes.
    const foreign = await vehicleOf(other.company.id, 'Furgone', 'vehicle', 'AB123CD')
    await refueling(other.company.id, foreign, '2026-10-01', '9.00', 900)
    const get = async (query: string) => {
      const res = await browser.call('GET', `${url}?${query}`)
      expect(res.statusCode).toBe(200)
      return res.json<List & { meta: { total: number } }>()
    }
    const vanList = await get('filter[q]=%20FURGONE%20')
    expect(vanList.data.map((r) => r.id)).toEqual([b, a])
    // 0.10 + 0.20 without floating point.
    expect(vanList.total_liters).toBe('0.30')
    expect(vanList.total_amount).toBe('0.30')
    expect((await get('filter[q]=ab123cd')).data.map((r) => r.id)).toEqual([b, a])
    expect((await get('filter[q]=nord')).data.map((r) => r.id)).toEqual([b])
    expect((await get('filter[q]=tanica')).data.map((r) => r.id)).toEqual([c])
    expect((await get(`filter[q]=furgone&filter[vehicle]=${digger}`)).meta.total).toBe(0)
    expect((await get('filter[q]=%25')).meta.total).toBe(0)
    expect((await get('filter[q]=ab_23')).meta.total).toBe(0)
    expect((await get('filter[q]=%20%20')).meta.total).toBe(3)
    const csv = await browser.call(
      'GET',
      `/api/companies/${company.slug}/vehicle-refuelings/export?filter[q]=furgone`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.replace('\ufeff', '').trim().split('\r\n')).toHaveLength(3)
    for (const query of [`filter[q]=${'a'.repeat(101)}`, 'filter[q]=a&filter[q]=b']) {
      for (const target of [url, `${url}/export`]) {
        const res = await browser.call('GET', `${target}?${query}`)
        expect(res.statusCode).toBe(422)
        expect(res.json<{ errors: Record<string, unknown> }>().errors).toHaveProperty(['filter[q]'])
      }
    }
  })

  it('rejects wrong filters and pages', async () => {
    const { browser, url } = await scene()
    for (const query of [
      'filter[to]=2026-02-30',
      'filter[from]=2026-11-02&filter[to]=2026-11-01',
      'filter[vehicle]=nope',
      'page=x',
      'per_page=0',
    ]) {
      expect((await browser.call('GET', `${url}?${query}`)).statusCode).toBe(422)
    }
  })

  it('needs vehicles.view and shows only the company’s refuelings', async () => {
    const none = await scene(['sites.view'])
    expect((await none.browser.call('GET', none.url)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', none.url)).statusCode).toBe(401)

    const mine = await scene()
    const theirs = await scene()
    const their = await vehicleOf(theirs.company.id, 'Loro', 'vehicle', 'ZZ999ZZ')
    await refueling(theirs.company.id, their, '2026-10-01', '30.00', 4500)
    const empty = {
      data: [],
      meta: { total: 0, page: 1, per_page: 25 },
      total_liters: '0.00',
      total_amount: '0.00',
    }
    expect((await mine.browser.call('GET', mine.url)).json()).toEqual(empty)
    const filtered = await mine.browser.call('GET', `${mine.url}?filter[vehicle]=${their}`)
    expect(filtered.json()).toEqual(empty)
    const other = `/api/companies/${theirs.company.slug}/vehicle-refuelings`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
  })
})
