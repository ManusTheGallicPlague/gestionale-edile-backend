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
  'employees.view',
  'employees.update',
  'deadlines.view',
  'deadlines.update',
]

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Luca', 'Bianchi') returning id",
    [company.id],
  )
  const employee = rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/employees/${employee}/documents`
  const deadlines = `/api/companies/${company.slug}/deadlines?filter[employee]=${employee}`
  return { browser, company, employee, base, deadlines }
}

const doc = (overrides: Record<string, unknown> = {}) => ({
  kind: 'medical_check',
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
  employee_id: string | null
  employee_document_id: string | null
}

function isoDay(offset: number): string {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }))
  today.setDate(today.getDate() + offset)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
}

describe('documents of an employee', () => {
  it('lists, creates, updates and deletes, with the status and the ETag', async () => {
    const { browser, employee, base } = await scene()
    const empty = await browser.call('GET', base)
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: [] })

    const created = await browser.call('POST', base, {
      body: doc({ expires_on: isoDay(10), notes: '  Medico competente  ' }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers.etag).toBe('"1"')
    expect(created.json()).toMatchObject({
      employee_id: employee,
      kind: 'medical_check',
      expires_on: isoDay(10),
      notes: 'Medico competente',
      status: 'expiring',
    })
    const id = created.json<{ id: string }>().id

    await browser.call('POST', base, {
      body: doc({ kind: 'first_aid', issued_on: null, expires_on: null }),
    })
    await browser.call('POST', base, {
      body: doc({ kind: 'safety_training', expires_on: isoDay(-1) }),
    })
    await browser.call('POST', base, { body: doc({ kind: 'fire_safety', expires_on: isoDay(90) }) })
    const list = (await browser.call('GET', base)).json<{
      data: { kind: string; status: string }[]
    }>()
    expect(list.data.map((d) => [d.kind, d.status])).toEqual([
      ['safety_training', 'expired'],
      ['medical_check', 'expiring'],
      ['fire_safety', 'valid'],
      ['first_aid', 'no_expiry'],
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
      [{ kind: 'insurance' }, 'kind'],
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
      `select (select count(*) from public.employee_documents where company_id = $1) +
              (select count(*) from public.deadlines where company_id = $1) as n`,
      [company.id],
    )
    expect(rows.rows[0]?.n).toBe('0')
  })

  it('becomes a deadline of the employee, kept in step with the expiry', async () => {
    const { browser, employee, base, deadlines, company } = await scene()
    const created = await browser.call('POST', base, { body: doc() })
    const id = created.json<{ id: string }>().id
    let list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      title: 'Idoneità sanitaria – Bianchi Luca',
      due_on: '2027-03-01',
      kind: 'medical_check',
      status: 'open',
      employee_id: employee,
      employee_document_id: id,
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
      body: doc({ notes: 'Visita fatta' }),
      headers: { 'if-match': '"1"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data[0]).toMatchObject({ id: deadlineId, status: 'done' })

    // The renewal reopens it; the description names it.
    await browser.call('PUT', `${base}/${id}`, {
      body: doc({ kind: 'other', description: 'Corso ponteggi', expires_on: '2028-03-01' }),
      headers: { 'if-match': '"2"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      id: deadlineId,
      title: 'Corso ponteggi – Bianchi Luca',
      due_on: '2028-03-01',
      kind: 'other',
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
      body: doc({ kind: 'safety_training' }),
      headers: { 'if-match': '"4"' },
    })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data[0]).toMatchObject({
      title: 'Formazione sicurezza – Bianchi Luca',
      kind: 'training',
      employee_document_id: id,
    })
    await browser.call('DELETE', `${base}/${id}`, { headers: { 'if-match': '"5"' } })
    list = (await browser.call('GET', deadlines)).json<{ data: Deadline[] }>()
    expect(list.data).toHaveLength(0)
  })

  it('blocks deleting the employee while a deadline is there; the company goes in one go', async () => {
    const { browser, company, employee, base } = await scene([...ALL, 'employees.delete'])
    const created = await browser.call('POST', base, { body: doc() })
    await browser.call('POST', base, { body: doc({ kind: 'first_aid', expires_on: null }) })
    const blocked = await browser.call(
      'DELETE',
      `/api/companies/${company.slug}/employees/${employee}`,
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
      `/api/companies/${company.slug}/employees/${employee}`,
      { headers: { 'if-match': '"1"' } },
    )
    expect(removed.statusCode).toBe(204)
    const left = await ctx.owner.query(
      'select 1 from public.employee_documents where employee_id = $1',
      [employee],
    )
    expect(left.rowCount).toBe(0)

    const another = await scene()
    await another.browser.call('POST', another.base, { body: doc() })
    await ctx.owner.query('delete from public.companies where id = $1', [another.company.id])
    const gone = await ctx.owner.query(
      `select 1 from public.deadlines where company_id = $1
       union all select 1 from public.employee_documents where company_id = $1`,
      [another.company.id],
    )
    expect(gone.rowCount).toBe(0)
  })

  it('answers 404, 403 and 401 as the other parts of the employee', async () => {
    const mine = await scene()
    const theirs = await scene()
    const theirDoc = (await theirs.browser.call('POST', theirs.base, { body: doc() })).json<{
      id: string
    }>().id

    // An employee or a document of another company is not there.
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

    // Who can only look: 403 on writes; who cannot see employees: 404.
    const viewer = await scene(['employees.view'])
    expect((await viewer.browser.call('GET', viewer.base)).statusCode).toBe(200)
    expect((await viewer.browser.call('POST', viewer.base, { body: doc() })).statusCode).toBe(403)
    const blind = await scene(['deadlines.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)

    // Signed out.
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', mine.base)).statusCode).toBe(401)
  })

  it('creates the deadline even for who cannot see the calendar, only in its company', async () => {
    const mine = await scene(['employees.view', 'employees.update'])
    const created = await mine.browser.call('POST', mine.base, {
      body: doc({ kind: 'license' }),
    })
    expect(created.statusCode).toBe(201)
    const { rows } = await ctx.owner.query<{ company_id: string; title: string }>(
      'select company_id, title from public.deadlines where employee_document_id = $1',
      [created.json<{ id: string }>().id],
    )
    expect(rows).toEqual([{ company_id: mine.company.id, title: 'Patentino – Bianchi Luca' }])
  })
})
