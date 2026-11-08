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
    "insert into public.vehicles (company_id, name, kind) values ($1, 'Furgone', 'vehicle') returning id",
    [company.id],
  )
  const vehicle = rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/vehicles/${vehicle}/documents`
  const deadlines = `/api/companies/${company.slug}/deadlines?filter[vehicle]=${vehicle}`
  return { browser, company, vehicle, base, deadlines }
}

const doc = (overrides: Record<string, unknown> = {}) => ({
  kind: 'insurance',
  description: null,
  issued_on: '2026-03-01',
  expires_on: '2027-03-01',
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
  vehicle_document_id: string | null
}

function isoDay(offset: number): string {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }))
  today.setDate(today.getDate() + offset)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
}

describe('documents of a vehicle', () => {
  it('lists, creates, updates and deletes, with the status and the ETag', async () => {
    const { browser, vehicle, base } = await scene()
    const empty = await browser.call('GET', base)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [] })

    const created = await browser.call('POST', base, {
      body: doc({ expires_on: isoDay(10), notes: '  Polizza n. 123  ' }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({
      vehicle_id: vehicle,
      kind: 'insurance',
      expires_on: isoDay(10),
      notes: 'Polizza n. 123',
      status: 'expiring',
    })
    const id = created.json<{ id: string }>().id

    await browser.call('POST', base, {
      body: doc({ kind: 'registration', issued_on: null, expires_on: null }),
    })
    await browser.call('POST', base, { body: doc({ kind: 'road_tax', expires_on: isoDay(-1) }) })
    await browser.call('POST', base, { body: doc({ kind: 'tachograph', expires_on: isoDay(90) }) })
    const list = (await browser.call('GET', base)).json<{
      data: { kind: string; status: string }[]
    }>()
    expect(list.data.map((d) => [d.kind, d.status])).toEqual([
      ['road_tax', 'expired'],
      ['insurance', 'expiring'],
      ['tachograph', 'valid'],
      ['registration', 'no_expiry'],
    ])

    const updated = await browser.call('PUT', `${base}/${id}`, {
      body: doc({ expires_on: '2028-01-01' }),
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ expires_on: '2028-01-01', notes: null })

    const stale = await browser.call('PUT', `${base}/${id}`, {
      body: doc(),
      headers: { 'if-match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({ code: 'stale_record' })
    const missing = await browser.call('PUT', `${base}/${id}`, { body: doc() })
    expect(missing.statusCode).toBe(428)
    const staleDelete = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(staleDelete.statusCode).toBe(412)
    const deleted = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(deleted.statusCode).toBe(204)
    const again = await browser.call('DELETE', `${base}/${id}`, {
      headers: { 'if-match': '"2"' },
    })
    expect(again.statusCode).toBe(404)
  })

  it('refuses wrong fields one by one, without writing', async () => {
    const { browser, base, company } = await scene()
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: 'durc' }, 'kind'],
      [{ kind: 'other' }, 'description'],
      [{ description: 'x'.repeat(201) }, 'description'],
      [{ issued_on: '2026-02-30' }, 'issued_on'],
      [{ expires_on: '01/03/2027' }, 'expires_on'],
      [{ expires_on: 20270301 }, 'expires_on'],
      [{ expires_on: '2026-02-01' }, 'expires_on'],
      [{ notes: 'x'.repeat(2001) }, 'notes'],
    ]
    for (const [overrides, field] of cases) {
      const res = await browser.call('POST', base, { body: doc(overrides) })
      expect(res.statusCode).toBe(422)
      expect(Object.keys(res.json<{ errors: object }>().errors)).toEqual([field])
    }
    const withoutNotes: Record<string, unknown> = doc()
    delete withoutNotes.notes
    const absent = await browser.call('POST', base, { body: withoutNotes })
    expect(absent.statusCode).toBe(422)
    const rows = await ctx.owner.query<{ n: string }>(
      `select (select count(*) from public.vehicle_documents where company_id = $1) +
              (select count(*) from public.deadlines where company_id = $1) as n`,
      [company.id],
    )
    expect(rows.rows[0]?.n).toBe('0')
  })

  it('becomes a deadline of the vehicle, kept in step with the expiry', async () => {
    const { browser, vehicle, base, deadlines, company } = await scene()
    const created = await browser.call('POST', base, { body: doc() })
    const id = created.json<{ id: string }>().id
    let list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      title: 'Assicurazione – Furgone',
      due_on: '2027-03-01',
      kind: 'vehicle',
      status: 'open',
      vehicle_id: vehicle,
      vehicle_document_id: id,
    })
    const deadlineId = list.data[0]?.id ?? ''

    // Done in the calendar; a change that keeps the date leaves it done.
    const done = await browser.call(
      'POST',
      `/api/companies/${company.slug}/deadlines/${deadlineId}/complete`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(done.statusCode).toBe(200)
    await browser.call('PUT', `${base}/${id}`, {
      body: doc({ notes: 'Pagata' }),
      headers: { 'if-match': '"1"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data[0]).toMatchObject({ id: deadlineId, status: 'done' })

    // The renewal reopens it; the description names it.
    await browser.call('PUT', `${base}/${id}`, {
      body: doc({ kind: 'other', description: 'Polizza furto', expires_on: '2028-03-01' }),
      headers: { 'if-match': '"2"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      id: deadlineId,
      title: 'Polizza furto – Furgone',
      due_on: '2028-03-01',
      status: 'open',
    })

    // No expiry: no deadline. Back with a date, then deleting the document deletes it.
    await browser.call('PUT', `${base}/${id}`, {
      body: doc({ expires_on: null }),
      headers: { 'if-match': '"3"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(0)
    await browser.call('PUT', `${base}/${id}`, {
      body: doc({ kind: 'road_tax' }),
      headers: { 'if-match': '"4"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data[0]).toMatchObject({ title: 'Bollo – Furgone', vehicle_document_id: id })
    await browser.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"5"' } })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(0)
  })

  it('blocks deleting the vehicle while a deadline is there; the company goes in one go', async () => {
    const { browser, company, vehicle, base } = await scene([...ALL, 'vehicles.delete'])
    const created = await browser.call('POST', base, { body: doc() })
    await browser.call('POST', base, { body: doc({ kind: 'registration', expires_on: null }) })
    const blocked = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/vehicles/${vehicle}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'has_documents' })
    await browser.call('PUT', `${base}/${created.json<{ id: string }>().id}`, {
      body: doc({ expires_on: null }),
      headers: { 'if-match': '"1"' },
    })
    const removed = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/vehicles/${vehicle}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(removed.statusCode).toBe(204)
    const left = await ctx.owner.query(
      'select 1 from public.vehicle_documents where vehicle_id = $1',
      [vehicle],
    )
    expect(left.rowCount).toBe(0)

    const another = await scene()
    await another.browser.call('POST', another.base, { body: doc() })
    await ctx.owner.query('delete from public.companies where id = $1', [another.company.id])
    const gone = await ctx.owner.query(
      `select 1 from public.deadlines where company_id = $1
       union all select 1 from public.vehicle_documents where company_id = $1`,
      [another.company.id],
    )
    expect(gone.rowCount).toBe(0)
  })

  it('answers 404, 403 and 401 as the other parts of the vehicle', async () => {
    const mine = await scene()
    const theirs = await scene()
    const theirDoc = (await theirs.browser.call('POST', theirs.base, { body: doc() })).json<{
      id: string
    }>().id

    // A vehicle or a document of another company is not there.
    expect((await mine.browser.call('GET', theirs.base)).statusCode).toBe(404)
    expect((await mine.browser.call('POST', theirs.base, { body: doc() })).statusCode).toBe(404)
    const crossPath = `${mine.base}/${theirDoc}`
    const cross = await mine.browser.call('PUT', crossPath, {
      body: doc(),
      headers: { 'if-match': '"1"' },
    })
    expect(cross.statusCode).toBe(404)
    const crossDelete = await mine.browser.call('DELETE', crossPath, {
      headers: { 'if-match': '"1"' },
    })
    expect(crossDelete.statusCode).toBe(404)
    const theirList = (await theirs.browser.call('GET', theirs.base)).json<{ data: object[] }>()
    expect(theirList.data).toHaveLength(1)
    const notUuid = await mine.browser.call('PUT', `${mine.base}/abc`, {
      body: doc(),
      headers: { 'if-match': '"1"' },
    })
    expect(notUuid.statusCode).toBe(404)

    // Who can only look: 403 on writes; who cannot see vehicles: 404.
    const viewer = await scene(['vehicles.view'])
    expect((await viewer.browser.call('GET', viewer.base)).statusCode).toBe(200)
    expect((await viewer.browser.call('POST', viewer.base, { body: doc() })).statusCode).toBe(403)
    const blind = await scene(['deadlines.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)

    // Signed out.
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', mine.base)).statusCode).toBe(401)
  })

  it('creates the deadline even for who cannot see the calendar, only in its company', async () => {
    const mine = await scene(['vehicles.view', 'vehicles.update'])
    const created = await mine.browser.call('POST', mine.base, {
      body: doc({ kind: 'tachograph' }),
    })
    expect(created.statusCode).toBe(201)
    const { rows } = await ctx.owner.query<{ company_id: string; title: string }>(
      'select company_id, title from public.deadlines where vehicle_document_id = $1',
      [created.json<{ id: string }>().id],
    )
    expect(rows).toEqual([
      { company_id: mine.company.id, title: 'Taratura del tachigrafo – Furgone' },
    ])
  })

  it('filters the vehicles, their export and the dashboard by expired or expiring documents', async () => {
    const { browser, company, vehicle: renewed } = await scene()
    const add = async (name: string, docs: [string, number | null][]) => {
      const { rows } = await ctx.owner.query<{ id: string }>(
        "insert into public.vehicles (company_id, name, kind) values ($1, $2, 'vehicle') returning id",
        [company.id, name],
      )
      for (const [kind, days] of docs) {
        await ctx.owner.query(
          `insert into public.vehicle_documents (company_id, vehicle_id, kind, expires_on)
           values ($1, $2, $3, ${days === null ? 'null' : `$4::date`})`,
          days === null
            ? [company.id, rows[0]?.id, kind]
            : [company.id, rows[0]?.id, kind, isoDay(days)],
        )
      }
    }
    // The first vehicle: an old insurance expired, but renewed far away. Not listed.
    await ctx.owner.query(
      `insert into public.vehicle_documents (company_id, vehicle_id, kind, expires_on)
       values ($1, $2, 'insurance', $3), ($1, $2, 'insurance', $4)`,
      [company.id, renewed, isoDay(-30), isoDay(200)],
    )
    await add('Autocarro scaduto', [
      ['road_tax', -1],
      ['insurance', 10],
    ])
    await add('Gru in scadenza', [
      ['insurance', 30],
      ['registration', null],
    ])
    await add('Pala oggi', [['tachograph', 0]])
    await add('Ruspa tranquilla', [
      ['insurance', 31],
      ['registration', null],
    ])
    // Another company with an expired document: never in this list.
    const other = await scene()
    await ctx.owner.query(
      `insert into public.vehicle_documents (company_id, vehicle_id, kind, expires_on)
       values ($1, $2, 'road_tax', $3)`,
      [other.company.id, other.vehicle, isoDay(-5)],
    )

    const names = async (value: string) => {
      const res = await browser.call(
        'GET',
        `/api/companies/${company.slug}/vehicles?filter[documents]=${value}`,
      )
      expect(res.statusCode).toBe(200)
      return res.json<{ data: { name: string }[] }>().data.map((v) => v.name)
    }
    expect(await names('expired')).toEqual(['Autocarro scaduto'])
    expect(await names('expiring')).toEqual(['Gru in scadenza', 'Pala oggi'])

    const csv = await browser.call(
      'GET',
      `/api/companies/${company.slug}/vehicles/export?filter[documents]=expiring`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Gru in scadenza')
    expect(csv.body).not.toContain('Autocarro scaduto')
    expect(csv.body).not.toContain('Ruspa tranquilla')

    const wrong = await browser.call(
      'GET',
      `/api/companies/${company.slug}/vehicles?filter[documents]=valid`,
    )
    expect(wrong.statusCode).toBe(422)
    expect(Object.keys(wrong.json<{ errors: object }>().errors)).toEqual(['filter[documents]'])

    // The dashboard counts the same, only active vehicles.
    await add('Betoniera ferma', [['insurance', -3]])
    await ctx.owner.query(
      "update public.vehicles set active = false where company_id = $1 and name = 'Betoniera ferma'",
      [company.id],
    )
    const dashboard = `/api/companies/${company.slug}/dashboard`
    const d = await browser.call('GET', dashboard)
    expect(d.statusCode).toBe(200)
    expect(d.json<{ vehicles: unknown }>().vehicles).toEqual({
      documents_expired: 1,
      documents_expiring: 2,
    })
    const blind = await fx.user()
    await fx.member(
      blind.id,
      company.id,
      await fx.role(company.id, 'Senza mezzi', ['deadlines.view']),
    )
    const blindBrowser = new Browser(ctx.app)
    await blindBrowser.signIn(blind.email)
    const hidden = await blindBrowser.call('GET', dashboard)
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json<{ vehicles: unknown }>().vehicles).toBeNull()
  })
})
