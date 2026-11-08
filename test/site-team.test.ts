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

const ALL: Permission[] = ['sites.view', 'sites.update', 'sites.delete', 'employees.delete']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [company.id],
  )
  const employees = await ctx.owner.query<{ id: string }>(
    `insert into public.employees (company_id, first_name, last_name, job_title, hourly_cost_cents)
     values ($1, 'Luca', 'Verdi', 'Muratore', 2800), ($1, 'Anna', 'Bassi', null, 3000)
     returning id`,
    [company.id],
  )
  const siteId = site.rows[0]?.id ?? ''
  return {
    browser,
    company,
    siteId,
    verdi: employees.rows[0]?.id ?? '',
    bassi: employees.rows[1]?.id ?? '',
    url: `/api/companies/${company.slug}/sites/${siteId}/team`,
  }
}

type Team = { data: { employee_id: string; last_name: string }[] }

describe('site team', () => {
  it('replaces the team and lists it by name, without costs', async () => {
    const { browser, url, verdi, bassi } = await scene()
    expect((await browser.call('GET', url)).json<Team>().data).toEqual([])
    const res = await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi, verdi] } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Team>().data.map((m) => m.last_name)).toEqual(['Bassi', 'Verdi'])
    expect(JSON.stringify(res.json())).not.toContain('cost')
    const after = await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(after.json<Team>().data.map((m) => m.employee_id)).toEqual([verdi])
    expect((await browser.call('GET', url)).json<Team>().data).toHaveLength(1)
  })

  it.each([
    ['no list', {}],
    ['a list of numbers', { employee_ids: [1] }],
    ['too many', { employee_ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }],
    ['an unknown employee', { employee_ids: [crypto.randomUUID()] }],
  ])('refuses %s', async (_label, body) => {
    const { browser, url } = await scene()
    const res = await browser.call('PUT', url, { body })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ errors: { employee_ids: [expect.any(String)] } })
  })

  it('tells who is away today; why only with employees.view', async () => {
    const { browser, company, url, verdi, bassi } = await scene([...ALL, 'employees.view'])
    await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi] } })
    // Verdi sick from yesterday to today, Bassi with two hours of leave today and a holiday
    // starting tomorrow. Today is the Italian date.
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on, hours)
       select $1, x.employee_id, x.kind, d.today + x.from_day, d.today + x.to_day, x.hours
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ($2::uuid, 'sick_leave', -1, 0, null::numeric),
                 ($3::uuid, 'leave', 0, 0, 2),
                 ($3::uuid, 'vacation', 1, 5, null)) as x (employee_id, kind, from_day, to_day, hours)`,
      [company.id, verdi, bassi],
    )
    type Members = {
      data: {
        last_name: string
        away: boolean
        absence: string | null
        absence_hours: string | null
      }[]
    }
    const rows = (res: { json: <T>() => T }) =>
      res.json<Members>().data.map((m) => [m.last_name, m.away, m.absence, m.absence_hours])
    const seen = await browser.call('GET', url)
    expect(seen.statusCode).toBe(200)
    expect(rows(seen)).toEqual([
      ['Bassi', false, 'leave', '2.00'],
      ['Verdi', true, 'sick_leave', null],
    ])

    // A capo cantiere with sites.view only knows who is away, not why.
    const chief = new Browser(ctx.app)
    const role = await fx.role(company.id, 'Capo cantiere', ['sites.view', 'sites.update'])
    const person = await fx.user()
    await fx.member(person.id, company.id, role)
    await chief.signIn(person.email)
    const hidden = await chief.call('GET', url)
    expect(rows(hidden)).toEqual([
      ['Bassi', false, null, null],
      ['Verdi', true, null, null],
    ])
    expect(hidden.body).not.toContain('sick_leave')
    const replaced = await chief.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(rows(replaced)).toEqual([['Verdi', true, null, null]])

    // Ended absences, or of another company, do not count.
    const other = await scene()
    await other.browser.call('PUT', other.url, { body: { employee_ids: [other.verdi] } })
    await ctx.owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       select $1, $2, 'vacation', d - 10, d - 1
       from (select (now() at time zone 'Europe/Rome')::date as d) x`,
      [other.company.id, other.verdi],
    )
    const free = await other.browser.call('GET', other.url)
    expect(rows(free)).toEqual([['Verdi', false, null, null]])
  })

  it('tells who has an expired document, not which one', async () => {
    const { browser, company, url, verdi, bassi } = await scene()
    await browser.call('PUT', url, { body: { employee_ids: [verdi, bassi] } })
    // Verdi: the medical check expired yesterday. Bassi: a course expired, but the refresher is
    // on file, and the first aid expires today (still valid).
    await ctx.owner.query(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on, notes)
       select $1, x.employee_id, x.kind, d.today + x.days, 'n. 81'
       from (select (now() at time zone 'Europe/Rome')::date as today) d,
         (values ($2::uuid, 'medical_check', -1),
                 ($3::uuid, 'safety_training', -10),
                 ($3::uuid, 'safety_training', 300),
                 ($3::uuid, 'first_aid', 0)) as x (employee_id, kind, days)`,
      [company.id, verdi, bassi],
    )
    type Members = { data: { last_name: string; documents_expired: boolean }[] }
    const rows = (res: { json: <T>() => T }) =>
      res.json<Members>().data.map((m) => [m.last_name, m.documents_expired])
    const seen = await browser.call('GET', url)
    expect(seen.statusCode).toBe(200)
    expect(rows(seen)).toEqual([
      ['Bassi', false],
      ['Verdi', true],
    ])
    // Without employees.view nothing says which document, nor its notes.
    expect(seen.body).not.toContain('medical_check')
    expect(seen.body).not.toContain('n. 81')
    const replaced = await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    expect(rows(replaced)).toEqual([['Verdi', true]])

    // Documents of another company never reach this team.
    const other = await scene()
    await other.browser.call('PUT', other.url, { body: { employee_ids: [other.verdi] } })
    expect(rows(await other.browser.call('GET', other.url))).toEqual([['Verdi', false]])
  })

  it('an employee of another company cannot join; another company’s site is not found', async () => {
    const mine = await scene()
    const theirs = await scene()
    const res = await mine.browser.call('PUT', mine.url, {
      body: { employee_ids: [theirs.verdi] },
    })
    expect(res.statusCode).toBe(422)
    const other = `/api/companies/${mine.company.slug}/sites/${theirs.siteId}/team`
    expect((await mine.browser.call('GET', other)).statusCode).toBe(404)
    expect(
      (await mine.browser.call('PUT', other, { body: { employee_ids: [mine.verdi] } })).statusCode,
    ).toBe(404)
    expect((await theirs.browser.call('GET', theirs.url)).json<Team>().data).toEqual([])
  })

  it('an employee in a team cannot be deleted; deleting the site frees them', async () => {
    const { browser, company, url, verdi, siteId } = await scene()
    await browser.call('PUT', url, { body: { employee_ids: [verdi] } })
    const employee = `/api/companies/${company.slug}/employees/${verdi}`
    const refused = await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'has_documents' })
    const site = `/api/companies/${company.slug}/sites/${siteId}`
    expect(
      (await browser.call('DELETE', site, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
    expect(
      (await browser.call('DELETE', employee, { headers: { 'if-match': '"1"' } })).statusCode,
    ).toBe(204)
  })

  it('reading needs sites.view, changing sites.update', async () => {
    const reader = await scene(['sites.view'])
    expect((await reader.browser.call('GET', reader.url)).statusCode).toBe(200)
    expect(
      (await reader.browser.call('PUT', reader.url, { body: { employee_ids: [] } })).statusCode,
    ).toBe(403)
    const blind = await scene(['employees.view'])
    expect((await blind.browser.call('GET', blind.url)).statusCode).toBe(404)
  })
})
