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

    // Who deleted what: only the deletions, here with the document too.
    const deleted = await browser.call('GET', `${log}?filter[action]=delete`)
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json<{ data: Entry[]; meta: { total: number } }>()).toMatchObject({
      data: [{ entity: 'estimate', entity_id: id, action: 'delete', user: author }],
      meta: { total: 1 },
    })
    const creations = await browser.call('GET', `${log}?filter[action]=create`)
    expect(creations.json<{ data: Entry[] }>().data.map((e) => e.entity)).toEqual([
      'client',
      'estimate',
    ])
    const clientUpdates = await browser.call(
      'GET',
      `${log}?filter[action]=update&filter[entity]=client`,
    )
    expect(clientUpdates.json<{ meta: { total: number } }>().meta.total).toBe(0)
    // The other company's deletions are not in this log, nor this one's in theirs.
    const theirs = await fx.companyWithUser(['audit.view', 'estimates.create', 'estimates.delete'])
    const them = new Browser(ctx.app)
    await them.signIn(theirs.user.email)
    const theirLog = `/api/companies/${theirs.company.slug}/audit-log`
    expect(
      (await them.call('GET', `${theirLog}?filter[action]=delete`)).json<{
        meta: { total: number }
      }>().meta.total,
    ).toBe(0)
    expect((await them.call('GET', `${log}?filter[action]=delete`)).statusCode).toBe(404)
    for (const query of [
      'filter[action]=Eliminazione',
      'filter[action]=constructor',
      'filter[action]=delete&filter[action]=create',
    ]) {
      expect((await browser.call('GET', `${log}?${query}`)).statusCode).toBe(422)
      expect((await browser.call('GET', `${log}/export?${query}`)).statusCode).toBe(422)
    }
    const csv = await browser.call('GET', `${log}/export?filter[action]=delete`)
    expect(csv.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Data e ora;Utente;Documento;Id del documento;Azione;Campi',
      expect.stringMatching(new RegExp(`;Utente di prova;Computo metrico;${id};Eliminazione;$`)),
    ])
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

  it('records the payments of the invoices and the documents of the suppliers', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'invoices.view',
      'invoices.create',
      'invoices.update',
      'suppliers.view',
      'suppliers.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const one = async (sql: string, companyId = company.id) =>
      (await ctx.owner.query<{ id: string }>(sql, [companyId])).rows[0]?.id ?? ''
    const client = await one(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
    )
    const supplier = await one(
      "insert into public.suppliers (company_id, name) values ($1, 'Ponteggi Srl') returning id",
    )
    const base = `/api/companies/${company.slug}`
    const created = await browser.call('POST', `${base}/invoices`, {
      body: {
        direction: 'issued',
        number: '1/2026',
        date: '2026-11-02',
        client_id: client,
        supplier_id: null,
        site_id: null,
        description: null,
        taxable_amount: '0.30',
        vat_amount: '0',
        due_date: null,
        paid_on: null,
        notes: null,
      },
    })
    expect(created.statusCode).toBe(201)
    const invoice = created.json<{ id: string }>().id
    const etag = async () =>
      (await browser.call('GET', `${base}/invoices/${invoice}`)).headers.etag as string
    for (const amount of ['0.10', '0.20']) {
      const paid = await browser.call('POST', `${base}/invoices/${invoice}/payments`, {
        headers: { 'If-Match': await etag() },
        body: { date: '2026-11-10', amount, method: null, notes: null },
      })
      expect(paid.statusCode).toBe(200)
    }
    const payments = await browser.call('GET', `${base}/invoices/${invoice}/payments`)
    const [first, second] = payments.json<{ data: { id: string }[] }>().data.map((p) => p.id)
    const removed = await browser.call('DELETE', `${base}/invoices/${invoice}/payments/${second}`, {
      headers: { 'If-Match': await etag() },
    })
    expect(removed.statusCode).toBe(200)

    const documents = `${base}/suppliers/${supplier}/documents`
    const durc = {
      kind: 'durc',
      description: null,
      issued_on: '2026-10-01',
      expires_on: '2027-01-29',
      notes: null,
    }
    const doc = await browser.call('POST', documents, { body: durc })
    expect(doc.statusCode).toBe(201)
    const docId = doc.json<{ id: string }>().id
    const renewed = await browser.call('PUT', `${documents}/${docId}`, {
      headers: { 'if-match': '"1"' },
      body: { ...durc, expires_on: '2027-02-28' },
    })
    expect(renewed.statusCode).toBe(200)
    const deleted = await browser.call('DELETE', `${documents}/${docId}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(deleted.statusCode).toBe(204)

    // Another company's payment and document stay out of this log.
    const other = await fx.company()
    const theirSupplier = await one(
      "insert into public.suppliers (company_id, name) values ($1, 'Ponteggi Srl') returning id",
      other.id,
    )
    await ctx.owner.query(
      `insert into public.supplier_documents (company_id, supplier_id, kind) values ($1, $2, 'durc')`,
      [other.id, theirSupplier],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const paymentLog = await browser.call('GET', `${base}/audit-log?filter[entity]=invoice_payment`)
    expect(paymentLog.statusCode).toBe(200)
    expect(
      paymentLog
        .json<{ data: Entry[] }>()
        .data.map((e) => `${e.entity_id} ${e.action} ${e.user?.id ?? ''}`)
        .sort(),
    ).toEqual(
      [`${first} create`, `${second} create`, `${second} delete`]
        .map((e) => `${e} ${user.id}`)
        .sort(),
    )
    const docs = await browser.call('GET', `${base}/audit-log?filter[entity]=supplier_document`)
    expect(
      docs.json<{ data: Entry[] }>().data.map((e) => [e.entity_id, e.action, e.fields, e.user]),
    ).toEqual([
      [docId, 'delete', expect.anything(), author],
      [docId, 'update', ['expires_on'], author],
      [docId, 'create', expect.anything(), author],
    ])
    const csv = await browser.call(
      'GET',
      `${base}/audit-log/export?filter[entity]=supplier_document&filter[action]=update`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain(`Documento del fornitore;${docId};Modifica`)
  })

  it('records who entered and who deleted a warehouse movement', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'warehouse.view',
      'warehouse.create',
      'warehouse.delete',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const item = await ctx.owner.query<{ id: string }>(
      "insert into public.warehouse_items (company_id, code, name, unit) values ($1, 'CEM', 'Cemento', 'kg') returning id",
      [company.id],
    )
    const base = `/api/companies/${company.slug}`
    const moved = await browser.call('POST', `${base}/warehouse/movements`, {
      body: {
        item_id: item.rows[0]?.id,
        date: '2026-11-10',
        kind: 'in',
        quantity: '0.1',
        site_id: null,
        notes: null,
      },
    })
    expect(moved.statusCode).toBe(201)
    const id = moved.json<{ id: string }>().id
    const deleted = await browser.call('DELETE', `${base}/warehouse/movements/${id}`)
    expect(deleted.statusCode).toBe(204)
    // Another company's movement: not in this log.
    const other = await fx.company()
    const theirs = await ctx.owner.query<{ id: string }>(
      "insert into public.warehouse_items (company_id, code, name, unit) values ($1, 'CEM', 'Cemento', 'kg') returning id",
      [other.id],
    )
    await ctx.owner.query(
      `insert into public.warehouse_movements (company_id, item_id, movement_date, kind, quantity)
       values ($1, $2, '2026-11-10', 'in', 1)`,
      [other.id, theirs.rows[0]?.id],
    )
    const author = { id: user.id, name: 'Utente di prova' }
    const res = await browser.call('GET', `${base}/audit-log?filter[entity]=warehouse_movement`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: Entry[] }>().data.map((e) => [e.entity_id, e.action, e.user])).toEqual([
      [id, 'delete', author],
      [id, 'create', author],
    ])
    const csv = await browser.call(
      'GET',
      `${base}/audit-log/export?filter[entity]=warehouse_movement&filter[action]=delete`,
    )
    expect(csv.body).toContain(`Movimento di magazzino;${id};Eliminazione`)
  })

  it('records who changed a role, its permissions and the users of the company', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'users.view',
      'users.manage',
      'roles.manage',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}`
    const created = await browser.call('POST', `${base}/roles`, {
      body: { name: 'Capo cantiere', permissions: ['clients.view'] },
    })
    expect(created.statusCode).toBe(201)
    const roleId = created.json<{ id: string }>().id
    const put = (body: object) => browser.call('PUT', `${base}/roles/${roleId}`, { body })
    // Same name and permissions: nothing changes, nothing is logged.
    expect((await put({ name: 'Capo cantiere', permissions: ['clients.view'] })).statusCode).toBe(
      200,
    )
    // Only the permissions, then name and permissions together: one entry each.
    expect(
      (await put({ name: 'Capo cantiere', permissions: ['clients.view', 'sites.view'] }))
        .statusCode,
    ).toBe(200)
    expect((await put({ name: 'Capocantiere', permissions: ['sites.view'] })).statusCode).toBe(200)
    expect((await put({ name: 'Capo squadra', permissions: ['sites.view'] })).statusCode).toBe(200)
    const colleague = await fx.user({ name: 'Collega' })
    await fx.member(colleague.id, company.id, roleId)
    const users = `${base}/users/${colleague.id}`
    const ownerRole = await ctx.owner.query<{ id: string }>(
      "select id from public.roles where company_id = $1 and name = 'Titolare'",
      [company.id],
    )
    expect(
      (await browser.call('PUT', `${users}/role`, { body: { role_id: ownerRole.rows[0]?.id } }))
        .statusCode,
    ).toBe(200)
    expect((await browser.call('POST', `${users}/deactivate`)).statusCode).toBe(200)
    // Twice changes nothing, so no second entry.
    expect((await browser.call('POST', `${users}/deactivate`)).statusCode).toBe(200)
    expect((await browser.call('DELETE', `${base}/roles/${roleId}`)).statusCode).toBe(204)
    // Another company's role and member: not in this log.
    const other = await fx.company()
    const theirs = await fx.role(other.id, 'Altrui', ['clients.view'])
    await fx.member(colleague.id, other.id, theirs)
    await ctx.owner.query("update public.roles set name = 'Altri' where id = $1", [theirs])
    const author = { id: user.id, name: 'Utente di prova' }
    const roles = await browser.call('GET', `${base}/audit-log?filter[entity]=role`)
    expect(roles.statusCode).toBe(200)
    expect(
      roles
        .json<{ data: Entry[] }>()
        .data.filter((e) => e.entity_id === roleId)
        .map((e) => [e.entity_id, e.action, e.fields, e.user]),
    ).toEqual([
      [roleId, 'delete', [], author],
      [roleId, 'update', ['name'], author],
      [roleId, 'update', ['name', 'permissions'], author],
      [roleId, 'update', ['permissions'], author],
      [roleId, 'create', [], author],
    ])
    const members = await browser.call('GET', `${base}/audit-log?filter[entity]=user`)
    expect(members.statusCode).toBe(200)
    expect(
      members.json<{ data: Entry[] }>().data.map((e) => [e.entity_id, e.action, e.fields, e.user]),
    ).toEqual([
      [colleague.id, 'update', ['disabled_at'], author],
      [colleague.id, 'update', ['role_id'], author],
      // Added outside the API (as by the fixtures): no author.
      [colleague.id, 'create', [], null],
    ])
    const csv = await browser.call('GET', `${base}/audit-log/export?filter[entity]=user`)
    expect(csv.body).toContain(`Utente dell'azienda;${colleague.id};Modifica`)
    const roleCsv = await browser.call(
      'GET',
      `${base}/audit-log/export?filter[entity]=role&filter[action]=delete`,
    )
    expect(roleCsv.body).toContain(`Ruolo;${roleId};Eliminazione`)
  })

  it('records invitations and changes to the company details', async () => {
    const { company, user, roleId } = await fx.companyWithUser([
      'audit.view',
      'users.view',
      'users.manage',
      'settings.view',
      'settings.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}`
    const invite = async (email: string) => {
      const res = await browser.call('POST', `${base}/invitations`, {
        body: { email, role_id: roleId },
      })
      expect(res.statusCode).toBe(201)
      return res.json<{ id: string; token: string }>()
    }
    const withdrawn = await invite('ritirato@example.test')
    expect((await browser.call('DELETE', `${base}/invitations/${withdrawn.id}`)).statusCode).toBe(
      204,
    )
    const accepted = await invite('accettato@example.test')
    const guest = new Browser(ctx.app)
    await guest.request('GET', '/api/auth/csrf')
    const accept = await guest.call('POST', `/api/invitations/${accepted.token}/accept`, {
      body: { name: 'Nuova Persona', password: 'una-password-lunga' },
    })
    expect(accept.statusCode).toBe(204)

    const url = `${base}/settings/company`
    const profile = (version: number, overrides: Record<string, unknown> = {}) =>
      browser.call('PUT', url, {
        headers: { 'if-match': `"${version}"` },
        body: {
          legal_name: 'Edilizia Prova S.r.l.',
          vat_number: null,
          tax_code: null,
          rea: null,
          share_capital: null,
          street: null,
          postal_code: null,
          city: 'Torino',
          province: null,
          country: 'IT',
          phone: null,
          email: null,
          pec: null,
          iban: null,
          ...overrides,
        },
      })
    // First save with the patron saint day: only the creation.
    expect((await profile(0, { patron_saint_day: '06-24' })).statusCode).toBe(200)
    // Same values: no entry. Then the city alone, then the city and the day together.
    expect((await profile(1)).statusCode).toBe(200)
    expect((await profile(2, { city: 'Roma' })).statusCode).toBe(200)
    expect((await profile(3, { city: 'Milano', patron_saint_day: '12-07' })).statusCode).toBe(200)
    // Another company's details: not in this log.
    const other = await fx.company()
    await ctx.owner.query(
      "insert into public.company_profiles (company_id, legal_name) values ($1, 'Altra')",
      [other.id],
    )

    const author = { id: user.id, name: 'Utente di prova' }
    const entries = async (entity: string) => {
      const res = await browser.call('GET', `${base}/audit-log?filter[entity]=${entity}`)
      expect(res.statusCode).toBe(200)
      return res
        .json<{ data: Entry[] }>()
        .data.map((e) => [e.entity_id, e.action, e.fields, e.user])
    }
    const invitations = await entries('invitation')
    expect(invitations.slice(1)).toEqual([
      [accepted.id, 'create', [], author],
      [withdrawn.id, 'delete', [], author],
      [withdrawn.id, 'create', [], author],
    ])
    expect(invitations[0]?.slice(0, 3)).toEqual([
      accepted.id,
      'update',
      ['accepted_at', 'accepted_user_id'],
    ])
    expect(await entries('company_profile')).toEqual([
      [company.id, 'update', ['city', 'patron_saint_day'], author],
      [company.id, 'update', ['city'], author],
      [company.id, 'create', [], author],
    ])
    const csv = await browser.call('GET', `${base}/audit-log/export?filter[entity]=company_profile`)
    expect(csv.body).toContain(`Dati dell'azienda;${company.id};Modifica`)
    const invCsv = await browser.call(
      'GET',
      `${base}/audit-log/export?filter[entity]=invitation&filter[action]=delete`,
    )
    expect(invCsv.body).toContain(`Invito;${withdrawn.id};Eliminazione`)
  })

  it('filters by day on Italian time and exports the log in CSV', async () => {
    const { company, user } = await fx.companyWithUser([
      'audit.view',
      'estimates.view',
      'estimates.create',
      'estimates.update',
    ])
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const base = `/api/companies/${company.slug}/estimates`
    const created = await browser.call('POST', base, { body: estimate() })
    const id = created.json<{ id: string }>().id
    const changed = await browser.call('PUT', `${base}/${id}`, {
      body: estimate({ title: 'Bagno; cucina', status: 'final' }),
      headers: { 'if-match': '"1"' },
    })
    expect(changed.statusCode).toBe(200)
    await ctx.owner.query(
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Senza autore')",
      [company.id],
    )
    // 23:30 UTC on 31 October is already 1 November in Italy.
    const at = async (entity: string, action: string, time: string) =>
      ctx.owner.query(
        'update public.audit_log set created_at = $1 where company_id = $2 and entity = $3 and action = $4',
        [time, company.id, entity, action],
      )
    await at('estimate', 'create', '2026-10-31 23:30:00+00')
    await at('estimate', 'update', '2026-11-02 13:05:00+00')
    await at('client', 'create', '2026-11-03 08:00:00+00')
    // Another company's change on the same days is never exported.
    const theirs = await fx.companyWithUser(['audit.view', 'estimates.create'])
    const them = new Browser(ctx.app)
    await them.signIn(theirs.user.email)
    const their = `/api/companies/${theirs.company.slug}/estimates`
    expect((await them.call('POST', their, { body: estimate() })).statusCode).toBe(201)

    const log = `/api/companies/${company.slug}/audit-log`
    const november1 = await browser.call(
      'GET',
      `${log}?filter[from]=2026-11-01&filter[to]=2026-11-01`,
    )
    expect(november1.statusCode).toBe(200)
    expect(november1.json<{ data: Entry[] }>().data).toMatchObject([
      { entity: 'estimate', action: 'create' },
    ])
    const fromTwo = await browser.call('GET', `${log}?filter[from]=2026-11-02`)
    expect(fromTwo.json<{ meta: { total: number } }>().meta.total).toBe(2)
    const october = await browser.call('GET', `${log}?filter[to]=2026-10-31`)
    expect(october.json<{ meta: { total: number } }>().meta.total).toBe(0)
    expect((await browser.call('GET', `${log}?filter[from]=01/11/2026`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${log}?filter[to]=2026-02-30`)).statusCode).toBe(422)

    const url = `${log}/export`
    const res = await browser.call('GET', url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="registro-modifiche.csv"')
    expect(res.body.replace('﻿', '').trim().split('\r\n')).toEqual([
      'Data e ora;Utente;Documento;Id del documento;Azione;Campi',
      `03/11/2026 09:00;;Cliente;${(await clientId(company.id)) ?? ''};Creazione;`,
      `02/11/2026 14:05;Utente di prova;Computo metrico;${id};Modifica;status, title`,
      `01/11/2026 00:30;Utente di prova;Computo metrico;${id};Creazione;`,
    ])
    const filtered = await browser.call(
      'GET',
      `${url}?filter[entity]=estimate&filter[user]=${user.id}&filter[from]=2026-11-02`,
    )
    expect(filtered.body.trim().split('\r\n')).toHaveLength(2)
    expect(filtered.body).toContain('Modifica')
    expect((await browser.call('GET', `${url}?filter[entity]=boh`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${url}?filter[from]=ieri`)).statusCode).toBe(422)
    expect((await browser.call('GET', `${url}?filter[user]=x`)).statusCode).toBe(422)

    // Without audit.view, from another company and without a session.
    const reader = await fx.user()
    await fx.member(reader.id, company.id, await fx.role(company.id, 'Lettore', ['estimates.view']))
    const readerBrowser = new Browser(ctx.app)
    await readerBrowser.signIn(reader.email)
    expect((await readerBrowser.call('GET', url)).statusCode).toBe(403)
    expect((await them.call('GET', url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
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

async function clientId(companyId: string): Promise<string | undefined> {
  const { rows } = await ctx.owner.query<{ id: string }>(
    'select id from public.clients where company_id = $1',
    [companyId],
  )
  return rows[0]?.id
}
