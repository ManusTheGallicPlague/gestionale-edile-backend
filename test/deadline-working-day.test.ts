import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nextWorkingDay } from '../src/holidays.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

type Deadline = { id: string; due_on: string; working_due_on: string }

async function scene(patron: string | null = null) {
  const { company, user } = await fx.companyWithUser([
    'deadlines.view',
    'deadlines.create',
    'deadlines.update',
  ])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  if (patron) {
    await ctx.owner.query(
      `insert into public.company_profiles (company_id, legal_name, patron_saint_day)
       values ($1, 'Edile Prova srl', $2)`,
      [company.id, patron],
    )
  }
  const base = `/api/companies/${company.slug}/deadlines`
  async function create(dueOn: string): Promise<Deadline> {
    const res = await browser.call('POST', base, {
      body: {
        title: `Scadenza del ${dueOn}`,
        due_on: dueOn,
        kind: 'tax',
        amount: null,
        client_id: null,
        supplier_id: null,
        notes: null,
        recurrence: null,
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json<Deadline>()
  }
  return { browser, company, base, create }
}

describe('first working day of a deadline', () => {
  it('moves Saturdays, Sundays and holidays to the next working day', () => {
    expect(nextWorkingDay('2026-11-16', null)).toBe('2026-11-16') // Monday
    expect(nextWorkingDay('2026-11-14', null)).toBe('2026-11-16') // Saturday
    expect(nextWorkingDay('2026-11-15', null)).toBe('2026-11-16') // Sunday
    expect(nextWorkingDay('2026-12-08', null)).toBe('2026-12-09') // Immacolata, Tuesday
    expect(nextWorkingDay('2026-12-25', null)).toBe('2026-12-28') // Christmas, then the weekend
    expect(nextWorkingDay('2027-03-29', null)).toBe('2027-03-30') // Easter Monday
    expect(nextWorkingDay('2028-12-30', null)).toBe('2029-01-02') // into the new year
    expect(nextWorkingDay('2026-06-29', '06-29')).toBe('2026-06-30') // patron saint
    expect(nextWorkingDay('2026-06-29', null)).toBe('2026-06-29')
  })

  it('returns working_due_on on create, read, list and update', async () => {
    const s = await scene()
    const saturday = await s.create('2026-11-14')
    expect(saturday).toMatchObject({ due_on: '2026-11-14', working_due_on: '2026-11-16' })
    const weekday = await s.create('2026-11-17')
    expect(weekday.working_due_on).toBe('2026-11-17')
    const christmas = await s.create('2026-12-25')
    expect(christmas.working_due_on).toBe('2026-12-28')

    const read = await s.browser.call('GET', `${s.base}/${saturday.id}`)
    expect(read.json<Deadline>().working_due_on).toBe('2026-11-16')

    const list = await s.browser.call('GET', s.base)
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Deadline[] }>().data.map((d) => [d.due_on, d.working_due_on])).toEqual(
      [
        ['2026-11-14', '2026-11-16'],
        ['2026-11-17', '2026-11-17'],
        ['2026-12-25', '2026-12-28'],
      ],
    )

    // A new date moves the working day too.
    const updated = await s.browser.call('PUT', `${s.base}/${saturday.id}`, {
      headers: { 'if-match': '"1"' },
      body: {
        title: 'Spostata',
        due_on: '2026-12-08',
        kind: 'tax',
        amount: null,
        client_id: null,
        supplier_id: null,
        notes: null,
        recurrence: null,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ due_on: '2026-12-08', working_due_on: '2026-12-09' })
  })

  it('skips the patron saint day of the company, not of another one', async () => {
    const mine = await scene('06-29')
    expect((await mine.create('2026-06-29')).working_due_on).toBe('2026-06-30')
    // Patron saint on a Friday: the deadline jumps the weekend too.
    const friday = await scene('11-13')
    expect((await friday.create('2026-11-13')).working_due_on).toBe('2026-11-16')

    // Another company has its own patron saint: nothing changes here.
    const other = await scene()
    expect((await other.create('2026-06-29')).working_due_on).toBe('2026-06-29')
  })

  it('writes the first working day as the last CSV column', async () => {
    const s = await scene('06-29')
    await s.create('2026-06-27')
    await s.create('2026-06-26')
    const res = await s.browser.call('GET', `${s.base}/export`)
    expect(res.statusCode).toBe(200)
    const lines = res.body.replace('﻿', '').trim().split('\r\n')
    expect(lines[0]?.split(';').at(-1)).toBe('Primo giorno lavorativo')
    expect(lines.slice(1).map((l) => [l.split(';')[0], l.split(';').at(-1)])).toEqual([
      ['26/06/2026', '26/06/2026'],
      ['27/06/2026', '30/06/2026'],
    ])
  })
})
