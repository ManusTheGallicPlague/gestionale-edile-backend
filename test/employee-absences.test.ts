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

const ALL: Permission[] = ['employees.view', 'employees.update', 'employees.delete']

function body(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'vacation',
    starts_on: '2026-08-10',
    ends_on: '2026-08-21',
    hours: null,
    notes: null,
    ...overrides,
  }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.employees (company_id, first_name, last_name) values ($1, 'Mario', 'Operaio') returning id",
    [company.id],
  )
  const employee = rows[0]?.id ?? ''
  const employees = `/api/companies/${company.slug}/employees`
  return { browser, company, employee, employees, base: `${employees}/${employee}/absences` }
}

type Absence = {
  id: string
  kind: string
  starts_on: string
  ends_on: string
  hours: string | null
  days: number
}

describe('employee absences', () => {
  it('records a period and a few hours of leave, newest first, with the days', async () => {
    const { browser, base, employee } = await scene()
    const holiday = await browser.call('POST', base, { body: body() })
    expect(holiday.statusCode).toBe(201)
    expect(holiday.headers.etag).toBe('"1"')
    expect(holiday.json()).toMatchObject({
      employee_id: employee,
      kind: 'vacation',
      starts_on: '2026-08-10',
      ends_on: '2026-08-21',
      hours: null,
      days: 12,
      // Two weeks from Monday to Friday; 15/08 is a Saturday.
      working_days: 10,
    })
    const leave = await browser.call('POST', base, {
      body: body({ kind: 'leave', starts_on: '2026-09-03', ends_on: '2026-09-03', hours: '2.5' }),
    })
    expect(leave.statusCode).toBe(201)
    expect(leave.json()).toMatchObject({ hours: '2.50', days: 1, working_days: null })

    const list = await browser.call('GET', base)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Absence[] }>().data.map((a) => a.starts_on)).toEqual([
      '2026-09-03',
      '2026-08-10',
    ])
  })

  it('filters on the absences that touch the period, ends included', async () => {
    const { browser, base } = await scene()
    await browser.call('POST', base, { body: body() })
    await browser.call('POST', base, {
      body: body({ kind: 'sick_leave', starts_on: '2026-08-31', ends_on: '2026-09-02' }),
    })
    const of = async (query: string) =>
      (await browser.call('GET', `${base}?${query}`))
        .json<{ data: Absence[] }>()
        .data.map((a) => a.kind)
    expect(await of('filter[from]=2026-09-01&filter[to]=2026-09-30')).toEqual(['sick_leave'])
    expect(await of('filter[from]=2026-08-21&filter[to]=2026-08-31')).toEqual([
      'sick_leave',
      'vacation',
    ])
    expect(await of('filter[to]=2026-08-09')).toEqual([])
    expect(await of('filter[from]=2026-08-22&filter[to]=2026-08-30')).toEqual([])
    const bad = await browser.call('GET', `${base}?filter[from]=2026-09-30&filter[to]=2026-09-01`)
    expect(bad.statusCode).toBe(422)
    const wrong = await browser.call('GET', `${base}?filter[from]=31/08/2026`)
    expect(wrong.statusCode).toBe(422)
  })

  it.each([
    ['an unknown kind', { kind: 'sciopero' }, 'kind'],
    ['a missing start', { starts_on: null }, 'starts_on'],
    ['an impossible date', { ends_on: '2026-02-30' }, 'ends_on'],
    ['an end before the start', { ends_on: '2026-08-09' }, 'ends_on'],
    ['hours over more days', { hours: '4' }, 'hours'],
    ['too many hours', { ends_on: '2026-08-10', hours: '25' }, 'hours'],
    ['hours with a comma', { ends_on: '2026-08-10', hours: '2,5' }, 'hours'],
    ['other without notes', { kind: 'other' }, 'notes'],
  ])('refuses %s', async (_label, overrides, field) => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: body(overrides) })
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('refuses overlapping absences, but not when an absence is moved within itself', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: body() })
    const touching = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-21', ends_on: '2026-08-25' }),
    })
    expect(touching.statusCode).toBe(422)
    expect(touching.json<{ errors: object }>().errors).toHaveProperty('starts_on')
    const around = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-01', ends_on: '2026-08-31' }),
    })
    expect(around.statusCode).toBe(422)
    const next = await browser.call('POST', base, {
      body: body({ starts_on: '2026-08-22', ends_on: '2026-08-22' }),
    })
    expect(next.statusCode).toBe(201)

    const url = `${base}/${created.json<Absence>().id}`
    const shorter = await browser.call('PUT', url, {
      body: body({ ends_on: '2026-08-14' }),
      headers: { 'if-match': '"1"' },
    })
    expect(shorter.statusCode).toBe(200)
    const onTheNext = await browser.call('PUT', url, {
      body: body({ ends_on: '2026-08-22' }),
      headers: { 'if-match': '"2"' },
    })
    expect(onTheNext.statusCode).toBe(422)
  })

  it('updates with If-Match and deletes; stale is 412, missing is 428', async () => {
    const { browser, base } = await scene()
    const created = await browser.call('POST', base, { body: body() })
    const url = `${base}/${created.json<Absence>().id}`
    const changed = body({ kind: 'injury', notes: 'Infortunio in cantiere' })
    const updated = await browser.call('PUT', url, {
      body: changed,
      headers: { 'if-match': '"1"' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.headers.etag).toBe('"2"')
    expect(updated.json()).toMatchObject({ kind: 'injury', notes: 'Infortunio in cantiere' })
    const stale = await browser.call('PUT', url, { body: changed, headers: { 'if-match': '"1"' } })
    expect(stale.statusCode).toBe(412)
    expect((await browser.call('PUT', url, { body: changed })).statusCode).toBe(428)
    expect((await browser.call('DELETE', url)).statusCode).toBe(428)
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })).statusCode).toBe(
      412,
    )
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      204,
    )
    expect((await browser.call('GET', base)).json<{ data: Absence[] }>().data).toEqual([])
    expect((await browser.call('DELETE', url, { headers: { 'if-match': '"2"' } })).statusCode).toBe(
      404,
    )
  })

  it('the absences go with the employee when it is deleted', async () => {
    const { browser, base, employees, employee } = await scene()
    await browser.call('POST', base, { body: body() })
    const del = await browser.call('DELETE', `${employees}/${employee}`, {
      headers: { 'if-match': '"1"' },
    })
    expect(del.statusCode).toBe(204)
    const { rowCount } = await ctx.owner.query(
      'select 1 from public.employee_absences where employee_id = $1',
      [employee],
    )
    expect(rowCount).toBe(0)
  })

  it('reading needs employees.view (404), writing employees.update (403)', async () => {
    const blind = await scene(['clients.view'])
    expect((await blind.browser.call('GET', blind.base)).statusCode).toBe(404)
    const reader = await scene(['employees.view'])
    expect((await reader.browser.call('GET', reader.base)).statusCode).toBe(200)
    expect((await reader.browser.call('POST', reader.base, { body: body() })).statusCode).toBe(403)
    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', reader.base)).statusCode).toBe(401)
  })

  it('needs the CSRF token to write', async () => {
    const { browser, base } = await scene()
    const res = await browser.call('POST', base, { body: body(), csrf: false })
    expect(res.statusCode).toBe(403)
  })

  it('absences of another company, or of another employee, are out of reach', async () => {
    const mine = await scene()
    const theirs = await scene()
    const created = await theirs.browser.call('POST', theirs.base, { body: body() })
    const id = created.json<Absence>().id
    const headers = { 'if-match': '"1"' }

    const viaMyCompany = `/api/companies/${mine.company.slug}/employees/${theirs.employee}/absences`
    expect((await mine.browser.call('GET', viaMyCompany)).statusCode).toBe(404)
    expect((await mine.browser.call('POST', viaMyCompany, { body: body() })).statusCode).toBe(404)
    const underMine = `${mine.base}/${id}`
    expect((await mine.browser.call('PUT', underMine, { body: body(), headers })).statusCode).toBe(
      404,
    )
    expect((await mine.browser.call('DELETE', underMine, { headers })).statusCode).toBe(404)
    // Their absence does not block the same days for my employee.
    expect((await mine.browser.call('POST', mine.base, { body: body() })).statusCode).toBe(201)
    const still = await theirs.browser.call('GET', theirs.base)
    expect(still.json<{ data: Absence[] }>().data.map((a) => a.id)).toEqual([id])
  })
})

describe('absences of the whole company', () => {
  type Row = Absence & { employee: { id: string; last_name: string; active: boolean } }

  async function company(permissions: Permission[] = ALL) {
    const s = await scene(permissions)
    const { rows } = await ctx.owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name, active) values ($1, 'Anna', 'Bianchi', false) returning id",
      [s.company.id],
    )
    const other = rows[0]?.id ?? ''
    const add = (employee: string, kind: string, starts: string, ends: string) =>
      ctx.owner.query(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, notes)
         values ($1, $2, $3, $4, $5, 'x')`,
        [s.company.id, employee, kind, starts, ends],
      )
    await add(s.employee, 'vacation', '2026-08-10', '2026-08-21')
    await add(s.employee, 'sick_leave', '2026-09-01', '2026-09-02')
    await add(other, 'vacation', '2026-08-17', '2026-08-28')
    return { ...s, other, list: `/api/companies/${s.company.slug}/absences` }
  }

  it('lists every absence with its employee, newest first, filtered and paged', async () => {
    const { browser, list, employee, other } = await company()
    const all = await browser.call('GET', list)
    expect(all.statusCode).toBe(200)
    const body = all.json<{ data: Row[]; meta: object }>()
    expect(body.data.map((r) => [r.kind, r.employee.last_name, r.employee.active])).toEqual([
      ['sick_leave', 'Operaio', true],
      ['vacation', 'Bianchi', false],
      ['vacation', 'Operaio', true],
    ])
    expect(body.meta).toEqual({ total: 3, page: 1, per_page: 25 })

    const of = async (query: string) =>
      (await browser.call('GET', `${list}?${query}`)).json<{
        data: Row[]
        meta: { total: number }
      }>()
    // Who is away on one day.
    const day = await of('filter[from]=2026-08-21&filter[to]=2026-08-21')
    expect(day.data.map((r) => r.employee.id)).toEqual([other, employee])
    expect((await of('filter[from]=2026-08-22&filter[to]=2026-08-31')).meta.total).toBe(1)
    expect((await of('filter[kind]=vacation')).meta.total).toBe(2)
    expect((await of(`filter[employee]=${other}`)).data.map((r) => r.kind)).toEqual(['vacation'])
    const paged = await of('per_page=2&page=2')
    expect(paged.data).toHaveLength(1)
    expect(paged.meta).toEqual({ total: 3, page: 2, per_page: 2 })
  })

  it.each([
    ['filter[kind]=sciopero', 'filter[kind]'],
    ['filter[employee]=abc', 'filter[employee]'],
    ['filter[from]=2026-13-01', 'filter[from]'],
    ['filter[from]=2026-09-02&filter[to]=2026-09-01', 'filter[to]'],
    ['per_page=101', 'per_page'],
  ])('refuses %s', async (query, field) => {
    const { browser, list } = await company()
    const res = await browser.call('GET', `${list}?${query}`)
    expect(res.statusCode).toBe(422)
    expect(Object.keys(res.json<{ errors: object }>().errors)).toContain(field)
  })

  it('shows only the absences of this company', async () => {
    const mine = await company()
    const theirs = await company()
    const res = await mine.browser.call('GET', mine.list)
    const ids = res.json<{ data: Row[] }>().data.map((r) => r.employee.id)
    expect(new Set(ids)).toEqual(new Set([mine.employee, mine.other]))
    const filtered = await mine.browser.call('GET', `${mine.list}?filter[employee]=${theirs.other}`)
    expect(filtered.json<{ data: Row[] }>().data).toEqual([])
  })

  it('needs employees.view (403) and a session (401)', async () => {
    const blind = await company(['clients.view'])
    expect((await blind.browser.call('GET', blind.list)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', blind.list)).statusCode).toBe(401)
  })

  it('exports the same absences as CSV, with the same filters, for the payroll office', async () => {
    const s = await company()
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
       values ($1, $2, 'leave', '2026-09-03', '2026-09-03', 2.5, '=HYPERLINK("x")')`,
      [s.company.id, s.employee],
    )
    await company() // another company with the same absences
    const res = await s.browser.call('GET', `${s.list}/export`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="assenze.csv"')
    expect(res.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Cognome;Nome;Tipo;Sigla;Dal;Al;Giorni;Ore;Note',
      'Operaio;Mario;Permesso;PE;03/09/2026;03/09/2026;1;2,5;"\'=HYPERLINK(""x"")"',
      'Operaio;Mario;Malattia;MA;01/09/2026;02/09/2026;2;;x',
      'Bianchi;Anna;Ferie;FE;17/08/2026;28/08/2026;12;;x',
      'Operaio;Mario;Ferie;FE;10/08/2026;21/08/2026;12;;x',
    ])
    const filtered = await s.browser.call(
      'GET',
      `${s.list}/export?filter[kind]=vacation&filter[from]=2026-08-22`,
    )
    expect(filtered.body.replace('\uFEFF', '').trim().split('\r\n')).toEqual([
      'Cognome;Nome;Tipo;Sigla;Dal;Al;Giorni;Ore;Note',
      'Bianchi;Anna;Ferie;FE;17/08/2026;28/08/2026;12;;x',
    ])
    expect((await s.browser.call('GET', `${s.list}/export?filter[kind]=x`)).statusCode).toBe(422)
    const blind = await company(['clients.view'])
    expect((await blind.browser.call('GET', `${blind.list}/export`)).statusCode).toBe(403)
    expect((await new Browser(ctx.app).call('GET', `${blind.list}/export`)).statusCode).toBe(401)
  })
})

describe('absences in the calendar', () => {
  /** Unfolds the lines as a calendar would. */
  const unfold = (body: string) => body.replace(/\r\n /g, '').split('\r\n')

  async function scene2(permissions: Permission[] = ALL) {
    const s = await scene(permissions)
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
       values ($1, $2, 'vacation', '2026-12-28', '2027-01-04', null, 'Natale; al mare, forse'),
              ($1, $2, 'leave', '2026-09-03', '2026-09-03', 2.5, null)
       returning id`,
      [s.company.id, s.employee],
    )
    return {
      ...s,
      ids: rows.map((r) => r.id),
      url: `/api/companies/${s.company.slug}/absences/calendar`,
    }
  }

  it('exports every absence as all-day events from the first to the last day, without reminders', async () => {
    const s = await scene2()
    const other = await scene2() // another company with the same absences
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="assenze.ics"')
    expect(res.body.endsWith('\r\n')).toBe(true)
    for (const raw of res.body.split('\r\n')) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75)
    }
    const lines = unfold(res.body)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('PRODID:-//Gestionale edile//Assenze//IT')
    expect(lines).toContain('X-WR-CALNAME:Assenze')
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2)
    expect(lines).not.toContain('BEGIN:VALARM')
    for (const id of other.ids) expect(res.body).not.toContain(id)
    expect(lines).toContain(`UID:absence-${s.ids[0]}`)

    // The holidays across the new year end, exclusively, on the day after the last one.
    expect(lines).toContain('DTSTART;VALUE=DATE:20261228')
    expect(lines).toContain('DTEND;VALUE=DATE:20270105')
    expect(lines).toContain('DTSTART;VALUE=DATE:20260903')
    expect(lines).toContain('DTEND;VALUE=DATE:20260904')
    expect(lines.filter((l) => l.startsWith('SUMMARY:'))).toEqual([
      'SUMMARY:Operaio Mario – Ferie',
      'SUMMARY:Operaio Mario – Permesso 2\\,5 h',
    ])
    expect(lines).toContain(
      'DESCRIPTION:Tipo: Ferie (FE)\\nDal 28/12/2026 al 04/01/2027\\nGiorni: 8\\n\\nNatale\\; al mare\\, forse',
    )
    expect(lines).toContain('DESCRIPTION:Tipo: Permesso (PE)\\nIl 03/09/2026\\nOre: 2\\,5')

    // Same UIDs every time, so the calendar updates instead of duplicating.
    const again = await s.browser.call('GET', s.url)
    const uids = (body: string) => unfold(body).filter((l) => l.startsWith('UID:'))
    expect(uids(again.body)).toEqual(uids(res.body))
  })

  it('takes the same filters as the list, and refuses wrong ones', async () => {
    const s = await scene2()
    const count = async (query: string) => {
      const res = await s.browser.call('GET', `${s.url}?${query}`)
      expect(res.statusCode).toBe(200)
      return unfold(res.body).filter((l) => l === 'BEGIN:VEVENT').length
    }
    expect(await count('filter[from]=2027-01-04&filter[to]=2027-01-31')).toBe(1)
    expect(await count('filter[kind]=leave')).toBe(1)
    expect(await count('filter[kind]=sick_leave')).toBe(0)
    expect(await count(`filter[employee]=${s.employee}`)).toBe(2)
    const theirs = await scene2()
    expect(await count(`filter[employee]=${theirs.employee}`)).toBe(0)
    for (const query of [
      'filter[kind]=sciopero',
      'filter[from]=31/12/2026',
      'filter[employee]=x',
    ]) {
      expect((await s.browser.call('GET', `${s.url}?${query}`)).statusCode).toBe(422)
    }
  })

  it('needs employees.view (403), the company (404) and a session (401)', async () => {
    const s = await scene2()
    const blind = await scene2(['clients.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(403)
    expect((await blind.browser.call('GET', s.url)).statusCode).toBe(404)
    expect((await new Browser(ctx.app).call('GET', s.url)).statusCode).toBe(401)
  })
})

describe('absences in the monthly timesheet', () => {
  it('writes the code of the absence in its days, after the hours, only without a site', async () => {
    const s = await scene([...ALL, 'reports.view'])
    const q = (sql: string, values: unknown[]) => ctx.owner.query<{ id: string }>(sql, values)
    const site = (
      await q("insert into public.sites (company_id, name) values ($1, 'Villetta') returning id", [
        s.company.id,
      ])
    ).rows[0]?.id
    const report = (
      await q(
        "insert into public.daily_reports (company_id, site_id, report_date) values ($1, $2, '2026-11-03') returning id",
        [s.company.id, site],
      )
    ).rows[0]?.id
    await q(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 6, 0)`,
      [s.company.id, report, s.employee],
    )
    const away = (
      await q(
        "insert into public.employees (company_id, first_name, last_name) values ($1, 'Anna', 'Assente') returning id",
        [s.company.id],
      )
    ).rows[0]?.id
    const add = (employee: unknown, kind: string, from: string, to: string, hours: string | null) =>
      q(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours, notes)
         values ($1, $2, $3, $4, $5, $6, 'x')`,
        [s.company.id, employee, kind, from, to, hours],
      )
    await add(s.employee, 'leave', '2026-11-03', '2026-11-03', '2')
    await add(s.employee, 'sick_leave', '2026-11-30', '2026-12-04', null)
    // Across the start of the month, and a code for every kind.
    await add(away, 'vacation', '2026-10-28', '2026-11-02', null)
    await add(away, 'injury', '2026-11-10', '2026-11-10', null)
    await add(away, 'other', '2026-11-11', '2026-11-11', null)
    // Another month and another company are left out.
    await add(away, 'vacation', '2026-12-07', '2026-12-08', null)
    const theirs = await scene()
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       values ($1, $2, 'vacation', '2026-11-01', '2026-11-30')`,
      [theirs.company.id, theirs.employee],
    )

    const url = `/api/companies/${s.company.slug}/daily-reports/monthly-hours?month=2026-11`
    const read = async (query = '') => {
      const res = await s.browser.call('GET', `${url}${query}`)
      expect(res.statusCode).toBe(200)
      return res.body.replace('﻿', '').trim().split('\r\n').slice(1)
    }
    const days = Array.from({ length: 30 }, (_, i) => i + 1)
    const row = (last: string, first: string, cells: Record<number, string>, total: string) =>
      [last, first, '', ...days.map((d) => cells[d] ?? ''), total].join(';')
    expect(await read()).toEqual([
      row('Assente', 'Anna', { 1: 'FE', 2: 'FE', 10: 'IN', 11: 'AL' }, '0'),
      row('Operaio', 'Mario', { 3: '6 PE 2', 30: 'MA' }, '6'),
    ])
    // The file of a site has only the hours of that site.
    expect(await read(`&filter[site]=${site}`)).toEqual([row('Operaio', 'Mario', { 3: '6' }, '6')])
  })
})

describe('absences in the dashboard', () => {
  /** An ISO day, counted from today in Italy. */
  function day(offset: number): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date())
    const date = new Date(`${today}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
  }

  it('counts who is away today and the absences of the next 7 days, active employees only', async () => {
    const s = await scene()
    const employee = async (active: boolean) =>
      (
        await ctx.owner.query<{ id: string }>(
          "insert into public.employees (company_id, first_name, last_name, active) values ($1, 'X', 'Y', $2) returning id",
          [s.company.id, active],
        )
      ).rows[0]?.id
    const second = await employee(true)
    const inactive = await employee(false)
    const add = (who: unknown, from: number, to: number) =>
      ctx.owner.query(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
         values ($1, $2, 'vacation', $3, $4)`,
        [s.company.id, who, day(from), day(to)],
      )
    await add(s.employee, -2, 0) // away today, ends today
    await add(s.employee, 3, 4) // starts within the week
    await add(second, 0, 5) // away today, starts today: not "starting soon"
    await add(second, 7, 7) // starts on the seventh day
    await add(second, 8, 9) // too far
    await add(second, -5, -1) // already over
    await add(inactive, 0, 3) // not active: left out
    await add(inactive, 2, 2)
    const theirs = await scene()
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       values ($1, $2, 'vacation', $3, $3)`,
      [theirs.company.id, theirs.employee, day(1)],
    )
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/dashboard`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ absences: unknown }>().absences).toEqual({ away_today: 2, starting_soon: 2 })
    const none = await theirs.browser.call('GET', `/api/companies/${theirs.company.slug}/dashboard`)
    expect(none.json<{ absences: unknown }>().absences).toEqual({ away_today: 0, starting_soon: 1 })
  })

  it('is null without employees.view', async () => {
    const blind = await scene(['clients.view'])
    const res = await blind.browser.call('GET', `/api/companies/${blind.company.slug}/dashboard`)
    expect(res.json<{ absences: unknown }>().absences).toBeNull()
  })
})
