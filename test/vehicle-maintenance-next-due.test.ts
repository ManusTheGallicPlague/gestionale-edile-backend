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

const ALL: Permission[] = ['vehicles.view', 'vehicles.update', 'deadlines.view', 'deadlines.update']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.vehicles (company_id, name, kind) values ($1, 'Escavatore', 'machine') returning id",
    [company.id],
  )
  const vehicle = rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/vehicles/${vehicle}/maintenances`
  const deadlines = `/api/companies/${company.slug}/deadlines?filter[vehicle]=${vehicle}`
  return { browser, company, vehicle, base, deadlines }
}

const job = (overrides: Record<string, unknown> = {}) => ({
  performed_on: '2026-10-15',
  kind: 'service',
  description: 'Tagliando 500 ore',
  supplier_id: null,
  amount: null,
  meter_reading: 500,
  notes: null,
  ...overrides,
})

type Deadline = {
  id: string
  title: string
  due_on: string
  kind: string
  status: string
  vehicle_id: string | null
  vehicle_maintenance_id: string | null
}

describe('next maintenance of a vehicle', () => {
  it('becomes a deadline of the vehicle, kept in step with the date', async () => {
    const { browser, vehicle, base, deadlines, company } = await scene()

    // Without the field: no next date and no deadline.
    const plain = await browser.call('POST', base, { body: job() })
    expect(plain.statusCode).toBe(201)
    expect(plain.json()).toMatchObject({ next_due_on: null })

    const created = await browser.call('POST', base, {
      body: job({ next_due_on: '2027-04-15' }),
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    expect(created.json()).toMatchObject({ next_due_on: '2027-04-15' })

    let list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      title: 'Prossimo tagliando – Escavatore',
      due_on: '2027-04-15',
      kind: 'vehicle',
      status: 'open',
      vehicle_id: vehicle,
      vehicle_maintenance_id: id,
    })
    const deadlineId = list.data[0]?.id ?? ''

    // Done in the calendar, then a change that keeps the date leaves it done.
    const done = await browser.call(
      'POST',
      `/api/companies/${company.slug}/deadlines/${deadlineId}/complete`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(done.statusCode).toBe(200)
    const kept = await browser.call('PUT', `${base}/${id}`, {
      body: job({ notes: 'Filtri cambiati' }),
      headers: { 'if-match': '"1"' },
    })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toMatchObject({ next_due_on: '2027-04-15', notes: 'Filtri cambiati' })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data[0]).toMatchObject({ id: deadlineId, status: 'done' })

    // A new date reopens it, a new kind renames it.
    const moved = await browser.call('PUT', `${base}/${id}`, {
      body: job({ kind: 'inspection', next_due_on: '2027-05-02' }),
      headers: { 'if-match': '"2"' },
    })
    expect(moved.statusCode).toBe(200)
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      id: deadlineId,
      title: 'Prossima revisione – Escavatore',
      due_on: '2027-05-02',
      status: 'open',
    })

    // Null takes the deadline away; a date brings a new one; deleting the job deletes it.
    const cleared = await browser.call('PUT', `${base}/${id}`, {
      body: job({ next_due_on: null }),
      headers: { 'if-match': '"3"' },
    })
    expect(cleared.json()).toMatchObject({ next_due_on: null })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(0)
    await browser.call('PUT', `${base}/${id}`, {
      body: job({ next_due_on: '2027-06-01' }),
      headers: { 'if-match': '"4"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"5"' },
    })
    expect(deleted.statusCode).toBe(204)
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(0)
  })

  it('refuses a next date that is not after the job, without writing', async () => {
    const { browser, base, company } = await scene()
    for (const next_due_on of ['2026-10-15', '2026-10-01', '2027-02-30', '15/04/2027', 20270415]) {
      const res = await browser.call('POST', base, { body: job({ next_due_on }) })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual(['next_due_on'])
    }
    const created = await browser.call('POST', base, {
      body: job({ next_due_on: '2026-11-15' }),
    })
    const id = created.json<{ id: string }>().id
    // The kept next date still has to come after a new date of the job.
    const late = await browser.call('PUT', `${base}/${id}`, {
      body: job({ performed_on: '2026-11-15' }),
      headers: { 'if-match': '"1"' },
    })
    expect(late.statusCode).toBe(422)
    expect(Object.keys(late.json<{ errors: object }>().errors)).toEqual(['performed_on'])
    const rows = await ctx.owner.query<{ n: string }>(
      `select (select count(*) from public.vehicle_maintenances where company_id = $1) +
              (select count(*) from public.deadlines where company_id = $1) as n`,
      [company.id],
    )
    expect(rows.rows[0]?.n).toBe('2')
  })

  it('blocks deleting the vehicle while the deadline is there; the company goes in one go', async () => {
    const { browser, company, vehicle, base } = await scene([...ALL, 'vehicles.delete'])
    const created = await browser.call('POST', base, { body: job({ next_due_on: '2027-01-10' }) })
    const vehicleDelete = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/vehicles/${vehicle}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(vehicleDelete.statusCode).toBe(409)
    await browser.call('PUT', `${base}/${created.json<{ id: string }>().id}`, {
      body: job({ next_due_on: null }),
      headers: { 'if-match': '"1"' },
    })
    const again = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/vehicles/${vehicle}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(again.statusCode).toBe(204)

    const another = await scene()
    await another.browser.call('POST', another.base, { body: job({ next_due_on: '2027-01-10' }) })
    await ctx.owner.query('delete from public.companies where id = $1', [another.company.id])
    const gone = await ctx.owner.query('select 1 from public.deadlines where company_id = $1', [
      another.company.id,
    ])
    expect(gone.rowCount).toBe(0)
  })

  it('creates the deadline even for who cannot see the calendar, and only in its company', async () => {
    const mine = await scene(['vehicles.view', 'vehicles.update'])
    const theirs = await scene()
    await theirs.browser.call('POST', theirs.base, { body: job({ next_due_on: '2027-03-01' }) })
    const created = await mine.browser.call('POST', mine.base, {
      body: job({ kind: 'tires', next_due_on: '2027-03-01' }),
    })
    expect(created.statusCode).toBe(201)
    const { rows } = await ctx.owner.query<{ company_id: string; title: string }>(
      'select company_id, title from public.deadlines where vehicle_maintenance_id = $1',
      [created.json<{ id: string }>().id],
    )
    expect(rows).toEqual([{ company_id: mine.company.id, title: 'Cambio gomme – Escavatore' }])
    const theirList = (await theirs.browser.call('GET', theirs.deadlines)).json<{
      data: Deadline[]
    }>()
    expect(theirList.data).toHaveLength(1)
  })
})
