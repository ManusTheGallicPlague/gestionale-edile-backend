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

const estimate = (overrides: Record<string, unknown> = {}) => ({
  title: 'Bagno',
  client_id: null,
  site_id: null,
  site_address: null,
  status: 'draft',
  notes: null,
  ...overrides,
})

describe('audit log', () => {
  it('records who created, changed and deleted a record, newest first', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'estimates.view',
      'estimates.create',
      'estimates.update',
      'estimates.delete',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}/estimates`
    const created = await browser.call('POST', base, { body: estimate() })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const url = `${base}/${id}`
    const headers = { 'if-match': '"1"' }
    const same = await browser.call('PUT', url, { body: estimate(), headers })
    expect(same.statusCode).toBe(200)
    const changed = await browser.call('PUT', url, {
      body: estimate({ title: 'Bagno e cucina', status: 'final' }),
      headers: { 'if-match': '"2"' },
    })
    expect(changed.statusCode).toBe(200)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"3"' } })).statusCode).toBe(
      204,
    )
    // A change made outside the API has no author.
    await ctx.owner.query(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Senza autore')",
      [company.id],
    )

    const log = `/api/companies/${company.slug}/audit-log`
    const all = await browser.call('GET', log)
    expect(all.statusCode).toBe(200)
    const entries = all.json<{ data: Entry[]; meta: { total: number } }>()
    expect(entries.meta.total).toBe(4)
    const author = { id: user.id, name: 'Utente di prova' }
    expect(entries.data).toMatchObject([
      { entity: 'client', action: 'create', fields: [], user: null },
      { entity: 'estimate', entity_id: id, action: 'delete', fields: [], user: author },
      { entity: 'estimate', action: 'update', fields: ['status', 'title'], user: author },
      { entity: 'estimate', action: 'create', fields: [], user: author },
    ])

    const history = await browser.call(
      'GET',
      `${log}?filter[entity]=estimate&filter[entity_id]=${id}&per_page=1&page=2`,
    )
    const page = history.json<{ data: Entry[]; meta: { total: number } }>()
    expect(page.meta.total).toBe(3)
    expect(page.data.map((e) => e.action)).toEqual(['update'])
    const byUser = await browser.call('GET', `${log}?filter[user]=${user.id}`)
    expect(byUser.json<{ meta: { total: number } }>().meta.total).toBe(3)
    expect((await browser.call('GET', `${log}?filter[entity]=boh`)).statusCode).toBe(422)
    // Every entity of the contract is a valid filter (site_document was refused with 422).
    for (const entity of ['site_document', 'purchase_order']) {
      expect((await browser.call('GET', `${log}?filter[entity]=${entity}`)).statusCode).toBe(200)
    }
    expect((await browser.call('GET', `${log}?filter[entity_id]=x`)).statusCode).toBe(422)
  })

  it('records price lists, schedule activities and progress statements', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'price_lists.view',
      'price_lists.create',
      'price_lists.update',
      'sites.view',
      'sites.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}`
    const list = await browser.call('POST', `${base}/price-lists`, {
      body: { name: 'Prezzario', year: 2026, notes: null },
    })
    expect(list.statusCode).toBe(201)
    const listId = list.json<{ id: string }>().id
    const renamed = await browser.call('PUT', `${base}/price-lists/${listId}`, {
      headers: { 'if-match': '"1"' },
      body: { name: 'Prezzario 2026', year: 2026, notes: null },
    })
    expect(renamed.statusCode).toBe(200)

    const site = await ctx.owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
      [company.id],
    )
    const siteId = site.rows[0]?.id ?? ''
    const activity = await browser.call('POST', `${base}/sites/${siteId}/activities`, {
      body: {
        name: 'Scavi',
        start_on: '2026-11-09',
        end_on: '2026-11-13',
        progress: 0,
        depends_on: [],
        notes: null,
      },
    })
    expect(activity.statusCode).toBe(201)
    const activityId = activity.json<{ id: string }>().id

    // A SAL written outside the API: logged too, without an author.
    const est = await ctx.owner.query<{ id: string }>(
      "insert into public.estimates (company_id, title, site_id) values ($1, 'Computo', $2) returning id",
      [company.id, siteId],
    )
    const sal = await ctx.owner.query<{ id: string }>(
      `insert into public.progress_statements (company_id, estimate_id, number, statement_date)
       values ($1, $2, 1, '2026-11-30') returning id`,
      [company.id, est.rows[0]?.id],
    )
    const salId = sal.rows[0]?.id ?? ''
    await ctx.owner.query(
      "update public.progress_statements set status = 'approved', approved_at = now() where id = $1",
      [salId],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const log = `${base}/audit-log`
    const lists = await browser.call('GET', `${log}?filter[entity]=price_list`)
    expect(lists.statusCode).toBe(200)
    expect(lists.json<{ data: Entry[] }>().data).toMatchObject([
      { entity_id: listId, action: 'update', fields: ['name'], user: author },
      { entity_id: listId, action: 'create', user: author },
    ])
    const activities = await browser.call('GET', `${log}?filter[entity]=site_activity`)
    expect(activities.json<{ data: Entry[] }>().data).toMatchObject([
      { entity_id: activityId, action: 'create', user: author },
    ])
    const statements = await browser.call('GET', `${log}?filter[entity]=progress_statement`)
    expect(statements.json<{ data: Entry[] }>().data).toMatchObject([
      { entity_id: salId, action: 'update', fields: ['approved_at', 'status'], user: null },
      { entity_id: salId, action: 'create', user: null },
    ])
  })

  it('records the absences of the employees, with the names of the fields, not the values', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'employees.view',
      'employees.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const employee = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/employees/${employee.rows[0]?.id}/absences`
    const absence = { kind: 'vacation', starts_on: '2026-08-10', ends_on: '2026-08-14' }
    const created = await browser.call('POST', base, {
      body: { ...absence, hours: null, notes: null },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const changed = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: { ...absence, kind: 'sick_leave', hours: null, notes: null },
    })
    expect(changed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(deleted.statusCode).toBe(204)
    // Another company with an absence: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Anna', 'Bianchi') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       values ($1, $2, 'injury', '2026-08-10', '2026-08-14')`,
      [other.id, theirs.rows[0]?.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=employee_absence`,
    )
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: Entry[] }>().data
    expect(data).toMatchObject([
      { entity: 'employee_absence', entity_id: id, action: 'delete', user: author },
      {
        entity: 'employee_absence',
        entity_id: id,
        action: 'update',
        fields: ['kind'],
        user: author,
      },
      { entity: 'employee_absence', entity_id: id, action: 'create', user: author },
    ])
    expect(JSON.stringify(data)).not.toContain('sick_leave')
  })

  it('records the maintenance of the vehicles, with the names of the fields', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'vehicles.view',
      'vehicles.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const vehicle = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/vehicles/${vehicle.rows[0]?.id}/maintenances`
    const job = {
      performed_on: '2026-10-15',
      kind: 'service',
      description: 'Tagliando',
      supplier_id: null,
      amount: '300',
      meter_reading: 84500,
      notes: null,
    }
    const created = await browser.call('POST', base, { body: job })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const changed = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: { ...job, amount: '320.00' },
    })
    expect(changed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(deleted.statusCode).toBe(204)
    // Another company with a maintenance: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Gru', 'machine') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind, description)
       values ($1, $2, '2026-10-01', 'repair', 'Loro')`,
      [other.id, theirs.rows[0]?.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=vehicle_maintenance`,
    )
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: Entry[] }>().data
    expect(data).toMatchObject([
      { entity: 'vehicle_maintenance', entity_id: id, action: 'delete', user: author },
      {
        entity: 'vehicle_maintenance',
        entity_id: id,
        action: 'update',
        fields: ['amount_cents'],
        user: author,
      },
      { entity: 'vehicle_maintenance', entity_id: id, action: 'create', user: author },
    ])
    expect(data).toHaveLength(3)
  })

  it('records the refuelings of a vehicle, with the names of the fields', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'vehicles.view',
      'vehicles.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const vehicle = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/vehicles/${vehicle.rows[0]?.id}/refuelings`
    const fill = {
      refueled_on: '2026-10-15',
      liters: '45.2',
      amount: '80',
      meter_reading: 91200,
      supplier_id: null,
      notes: null,
    }
    const created = await browser.call('POST', base, { body: fill })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const changed = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: { ...fill, liters: '45.20', amount: '82.50' },
    })
    expect(changed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(deleted.statusCode).toBe(204)
    // Another company with a refueling: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Gru', 'machine') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
       values ($1, $2, '2026-10-01', 30, 5000)`,
      [other.id, theirs.rows[0]?.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=vehicle_refueling`,
    )
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: Entry[] }>().data
    // The same litres written with two decimals are not a change: only the amount.
    expect(data.map((e) => [e.entity_id, e.action, e.fields, e.user])).toEqual([
      [id, 'delete', expect.anything(), author],
      [id, 'update', ['amount_cents'], author],
      [id, 'create', expect.anything(), author],
    ])
  })

  it('records who recorded, renewed or deleted a document of a vehicle', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'vehicles.view',
      'vehicles.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const vehicle = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/vehicles/${vehicle.rows[0]?.id}/documents`
    const insurance = {
      kind: 'insurance',
      description: null,
      issued_on: '2026-03-01',
      expires_on: '2027-03-01',
      notes: null,
    }
    const created = await browser.call('POST', base, { body: insurance })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    // The same document again is not a change; the renewal is.
    const same = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: insurance,
    })
    expect(same.statusCode).toBe(200)
    const renewed = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
      body: { ...insurance, expires_on: '2028-03-01' },
    })
    expect(renewed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"3"' },
    })
    expect(deleted.statusCode).toBe(204)
    // Another company with a document: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'Gru', 'machine') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.vehicle_documents (company_id, vehicle_id, kind) values ($1, $2, 'road_tax')`,
      [other.id, theirs.rows[0]?.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=vehicle_document`,
    )
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: Entry[] }>().data
    expect(data.map((e) => [e.entity_id, e.action, e.fields, e.user])).toEqual([
      [id, 'delete', expect.anything(), author],
      [id, 'update', ['expires_on'], author],
      [id, 'create', expect.anything(), author],
    ])
  })

  it('records who recorded, renewed or deleted a document of an employee', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'employees.view',
      'employees.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const employee = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}/employees/${employee.rows[0]?.id}/documents`
    const training = {
      kind: 'safety_training',
      description: null,
      issued_on: '2026-03-01',
      expires_on: '2027-03-01',
      notes: null,
    }
    const created = await browser.call('POST', base, { body: training })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    // The same document again is not a change; the renewal is.
    const same = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
      body: training,
    })
    expect(same.statusCode).toBe(200)
    const renewed = await browser.call('PUT', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
      body: { ...training, expires_on: '2028-03-01' },
    })
    expect(renewed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"3"' },
    })
    expect(deleted.statusCode).toBe(204)
    // Another company with a document: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Anna', 'Bianchi') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind) values ($1, $2, 'first_aid')`,
      [other.id, theirs.rows[0]?.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=employee_document`,
    )
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: Entry[] }>().data
    expect(data.map((e) => [e.entity_id, e.action, e.fields, e.user])).toEqual([
      [id, 'delete', expect.anything(), author],
      [id, 'update', ['expires_on'], author],
      [id, 'create', expect.anything(), author],
    ])
  })

  it('records the vacation carried over as a change of the employee, without the days', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'employees.view',
      'employees.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const employee = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
      [company.id],
    )
    const id = employee.rows[0]?.id ?? ''
    const base = `/api/companies/${company.slug}/employees/${id}/leave-carryovers/2026`
    expect((await browser.call('PUT', base, { body: { days: 17 } })).statusCode).toBe(200)
    expect((await browser.call('PUT', base, { body: { days: 17 } })).statusCode).toBe(200)
    expect((await browser.call('PUT', base, { body: { days: 19 } })).statusCode).toBe(200)
    // Leave hours too: a change counts, the same hours written differently do not.
    const hours = (permit_hours: string) => browser.call('PUT', base, { body: { permit_hours } })
    expect((await hours('12.5')).statusCode).toBe(200)
    expect((await hours('12.50')).statusCode).toBe(200)
    expect((await browser.call('DELETE', base)).statusCode).toBe(204)
    // Another company with a carry-over: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'Anna', 'Bianchi') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
       values ($1, $2, 2026, 3)`,
      [other.id, theirs.rows[0]?.id],
    )

    const log = `/api/companies/${company.slug}/audit-log?filter[entity]=employee`
    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call('GET', log)
    expect(res.statusCode).toBe(200)
    // The same days again is not a change.
    const entries = res.json<{ data: Entry[] }>().data
    expect(entries.map((e) => [e.entity_id, e.action, e.fields, e.user])).toEqual([
      [id, 'update', ['leave_carryover'], author],
      [id, 'update', ['leave_carryover'], author],
      [id, 'update', ['leave_carryover'], author],
      [id, 'update', ['leave_carryover'], author],
      [id, 'create', [], null],
    ])
    expect(res.body).not.toContain('days')
    expect(res.body).not.toContain('12.5')

    // Deleting the employee logs the delete, not also the carry-overs that go with it.
    await browser.call('PUT', base, { body: { days: 2 } })
    await ctx.owner.query('delete from public.employees where id = $1', [id])
    const after = await browser.call('GET', log)
    expect(after.json<{ data: Entry[] }>().data.map((e) => e.action)).toEqual([
      'delete',
      'update',
      'update',
      'update',
      'update',
      'update',
      'create',
    ])
  })

  it('needs audit.view and shows only the company of the URL', async () => {
    const reader = await fx.companyWithUser(['estimates.view', 'estimates.create'])
    const browser = new Browser(ctx.app)
    await browser.signIn(reader.user.email)
    const created = await browser.call('POST', `/api/companies/${reader.company.slug}/estimates`, {
      body: estimate({ title: 'Segreto' }),
    })
    expect(created.statusCode).toBe(201)
    const log = `/api/companies/${reader.company.slug}/audit-log`
    expect((await browser.call('GET', log)).statusCode).toBe(403)

    const auditor = await fx.companyWithUser(['audit.view'])
    const other = new Browser(ctx.app)
    await other.signIn(auditor.user.email)
    expect((await other.call('GET', log)).statusCode).toBe(404)
    const own = await other.call('GET', `/api/companies/${auditor.company.slug}/audit-log`)
    expect(own.json<{ meta: { total: number } }>().meta.total).toBe(0)
  })
})
