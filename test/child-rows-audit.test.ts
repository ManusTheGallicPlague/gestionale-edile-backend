import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

type Entry = {
  entity: string
  entity_id: string
  action: string
  fields: string[]
  user: { id: string; name: string } | null
}

async function scene() {
  const { company, user } = await fx.companyWithUser([
    'audit.view',
    'reports.view',
    'reports.create',
    'reports.update',
    'purchases.view',
    'purchases.create',
    'purchases.update',
    'estimates.view',
    'estimates.update',
    'sites.view',
    'sites.update',
    'sites.delete',
  ])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const base = `/api/companies/${company.slug}`
  const one = async (sql: string, values: unknown[]) =>
    (await ctx.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? ''
  const site = await one(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [company.id],
  )
  const log = async (entity: string, id: string) => {
    const res = await browser.call('GET', `${base}/audit-log?filter[entity]=${entity}`)
    expect(res.statusCode).toBe(200)
    return res
      .json<{ data: Entry[] }>()
      .data.filter((e) => e.entity_id === id)
      .map((e) => [e.action, e.fields])
  }
  const put = async (url: string, body: unknown) => {
    const current = await browser.call('GET', url)
    expect(current.statusCode).toBe(200)
    const res = await browser.call('PUT', url, {
      headers: { 'if-match': String(current.headers.etag) },
      body,
    })
    expect(res.statusCode).toBe(200)
    return res
  }
  return { company, user, browser, base, site, one, log, put }
}

describe('change log of the rows inside a document', () => {
  it('records the hours of a daily report as labor and vehicles, not when saved unchanged', async () => {
    const s = await scene()
    const employee = await s.one(
      `insert into public.employees (company_id, first_name, last_name, hourly_cost_cents)
       values ($1, 'Luca', 'Verdi', 2800) returning id`,
      [s.company.id],
    )
    const vehicle = await s.one(
      `insert into public.vehicles (company_id, name, kind, hourly_cost_cents)
       values ($1, 'Escavatore', 'machine', 4500) returning id`,
      [s.company.id],
    )
    const report = {
      site_id: s.site,
      date: '2026-11-05',
      weather: 'Sereno',
      work_done: 'Getto del solaio',
      notes: null,
      labor: [{ employee_id: employee, hours: '8', description: null }],
      vehicles: [{ vehicle_id: vehicle, hours: '0.25', description: null }],
    }
    const created = await s.browser.call('POST', `${s.base}/daily-reports`, { body: report })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const url = `${s.base}/daily-reports/${id}`
    // Same hours saved again: nothing new in the log.
    await s.put(url, report)
    expect(await s.log('daily_report', id)).toEqual([['create', []]])
    // Hours of a person changed by a quarter of an hour.
    await s.put(url, {
      ...report,
      labor: [{ employee_id: employee, hours: '8.25', description: null }],
    })
    // Vehicle taken off together with the work done: one entry.
    await s.put(url, {
      ...report,
      labor: [{ employee_id: employee, hours: '8.25', description: null }],
      vehicles: [],
      work_done: 'Disarmo',
    })
    expect(await s.log('daily_report', id)).toEqual([
      ['update', ['vehicles', 'work_done']],
      ['update', ['labor']],
      ['create', []],
    ])
  })

  it('records the lines of a purchase order and of a progress statement', async () => {
    const s = await scene()
    const supplier = await s.one(
      "insert into public.suppliers (company_id, name) values ($1, 'Calcestruzzi Srl') returning id",
      [s.company.id],
    )
    const order = {
      supplier_id: supplier,
      site_id: s.site,
      date: '2026-11-04',
      delivery_date: null,
      notes: null,
      lines: [
        { description: 'Calcestruzzo C25/30', unit: 'm³', quantity: '0.1', unit_price: '0.20' },
        { description: 'Ferro B450C', unit: 'kg', quantity: '0.333', unit_price: '0.05' },
      ],
    }
    const created = await s.browser.call('POST', `${s.base}/purchase-orders`, { body: order })
    expect(created.statusCode).toBe(201)
    const orderId = created.json<{ id: string }>().id
    const orderUrl = `${s.base}/purchase-orders/${orderId}`
    await s.put(orderUrl, order)
    // Swapping two lines is a change; the quantity written as 0.100 is the same value.
    await s.put(orderUrl, {
      ...order,
      lines: [{ ...order.lines[1] }, { ...order.lines[0], quantity: '0.100' }],
    })
    expect(await s.log('purchase_order', orderId)).toEqual([
      ['update', ['lines']],
      ['create', []],
    ])

    const estimate = await s.one(
      "insert into public.estimates (company_id, title) values ($1, 'Villa') returning id",
      [s.company.id],
    )
    const chapter = await s.one(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Opere', 0) returning id`,
      [s.company.id, estimate],
    )
    const item = await s.one(
      `insert into public.estimate_items (company_id, estimate_id, chapter_id, description, unit,
         unit_price_cents, position) values ($1, $2, $3, 'Scavo', 'm³', 850, 0) returning id`,
      [s.company.id, estimate, chapter],
    )
    const statements = `${s.base}/estimates/${estimate}/progress-statements`
    const statement = {
      statement_date: '2026-10-31',
      notes: null,
      lines: [{ item_id: item, quantity: '0.1' }],
    }
    const first = await s.browser.call('POST', statements, { body: statement })
    expect(first.statusCode).toBe(201)
    const statementId = first.json<{ id: string }>().id
    const statementUrl = `${statements}/${statementId}`
    await s.put(statementUrl, statement)
    await s.put(statementUrl, { ...statement, lines: [{ item_id: item, quantity: '0.2' }] })
    await s.put(statementUrl, { ...statement, lines: [] })
    expect(await s.log('progress_statement', statementId)).toEqual([
      ['update', ['lines']],
      ['update', ['lines']],
      ['create', []],
    ])

    // Lines of another company's order: not in this log.
    const other = await fx.company()
    const theirSupplier = await s.one(
      "insert into public.suppliers (company_id, name) values ($1, 'Altrui') returning id",
      [other.id],
    )
    const theirOrder = await s.one(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         order_date) values ($1, 2026, 900, $2, '2026-11-04') returning id`,
      [other.id, theirSupplier],
    )
    await ctx.owner.query(
      `insert into public.purchase_order_lines (company_id, order_id, position, description,
         quantity, unit_price_cents) values ($1, $2, 0, 'Altrui', 1, 100)`,
      [other.id, theirOrder],
    )
    const all = await s.browser.call('GET', `${s.base}/audit-log`)
    expect(all.json<{ data: Entry[] }>().data.map((e) => e.entity_id)).not.toContain(theirOrder)
  })

  it('records the dependencies of a schedule activity, also when the other one goes', async () => {
    const s = await scene()
    const activities = `${s.base}/sites/${s.site}/activities`
    const activity = (name: string, dependsOn: string[] = []) => ({
      name,
      start_on: '2026-11-09',
      end_on: '2026-11-13',
      progress: 0,
      depends_on: dependsOn,
      notes: null,
    })
    const create = async (name: string) => {
      const res = await s.browser.call('POST', activities, { body: activity(name) })
      expect(res.statusCode).toBe(201)
      return res.json<{ id: string }>().id
    }
    const scavi = await create('Scavi')
    const fondazioni = await create('Fondazioni')
    const url = `${activities}/${fondazioni}`
    for (const version of ['"1"', '"2"']) {
      const res = await s.browser.call('PUT', url, {
        headers: { 'if-match': version },
        body: activity('Fondazioni', [scavi]),
      })
      expect(res.statusCode).toBe(200)
    }
    const deleted = await s.browser.call('DELETE', `${activities}/${scavi}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(deleted.statusCode).toBe(204)
    expect(await s.log('site_activity', fondazioni)).toEqual([
      ['update', ['dependencies']],
      ['update', ['dependencies']],
      ['create', []],
    ])
    expect(await s.log('site_activity', scavi)).toEqual([
      ['delete', []],
      ['create', []],
    ])
  })
})
