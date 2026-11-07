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

const ALL: Permission[] = ['invoices.view', 'invoices.create', 'invoices.update']

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  const role = await fx.role(company.id, 'Amministrazione', permissions)
  await fx.member(user.id, company.id, role)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const insert = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const client = await insert(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
  )
  const supplier = await insert(
    "insert into public.suppliers (company_id, name) values ($1, 'Laterizi di prova') returning id",
  )
  const base = `/api/companies/${company.slug}`
  return { browser, client, supplier, base }
}

type Scene = Awaited<ReturnType<typeof scene>>

/** Dates around today in Italy: today, yesterday, and the 15th of the month n from now. */
async function calendar() {
  const { rows } = await ctx.owner.query<Record<string, string>>(
    `select t.d::text as today, (t.d - 1)::text as yesterday,
       to_char(t.d, 'YYYY-MM') as m0,
       to_char(date_trunc('month', t.d) + interval '1 month', 'YYYY-MM') as m1,
       to_char(date_trunc('month', t.d) + interval '2 month', 'YYYY-MM') as m2,
       (date_trunc('month', t.d) + interval '1 month' + interval '14 days')::date::text as d1,
       (date_trunc('month', t.d) + interval '2 month' + interval '14 days')::date::text as d2,
       (date_trunc('month', t.d) + interval '3 month')::date::text as d3,
       (date_trunc('month', t.d) + interval '1 month' - interval '1 day')::date::text as end0,
       (t.d - 400)::text as long_ago
     from (select (now() at time zone 'Europe/Rome')::date as d) t`,
  )
  const r = rows[0]
  if (!r) throw new Error('no calendar')
  return r
}

async function invoice(s: Scene, overrides: Record<string, unknown>) {
  const res = await s.browser.call('POST', `${s.base}/invoices`, {
    body: {
      direction: 'issued',
      number: `F-${Math.random().toString(36).slice(2, 8)}`,
      date: (await calendar()).long_ago,
      client_id: s.client,
      supplier_id: null,
      site_id: null,
      description: null,
      taxable_amount: '1000',
      vat_amount: '220',
      due_date: null,
      paid_on: null,
      notes: null,
      ...overrides,
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ id: string }>()
}

const received = (s: Scene) => ({ direction: 'received', client_id: null, supplier_id: s.supplier })
const zero = { incoming: '0.00', outgoing: '0.00', net: '0.00' }

describe('cash flow forecast', () => {
  it('splits the open invoices by month of the due date, with the running balance', async () => {
    const s = await scene()
    const c = await calendar()
    // Overdue: issued yesterday-due with an advance, and a received one.
    const late = await invoice(s, { due_date: c.yesterday })
    const pay = await s.browser.call('POST', `${s.base}/invoices/${late.id}/payments`, {
      body: { date: c.long_ago, amount: '220', method: null, notes: null },
      headers: { 'If-Match': '"1"' },
    })
    expect(pay.statusCode).toBe(200)
    await invoice(s, {
      ...received(s),
      taxable_amount: '100',
      vat_amount: '0',
      due_date: c.yesterday,
    })
    // This month (due today counts as this month, not overdue) and at its end.
    await invoice(s, { taxable_amount: '50', vat_amount: '0', due_date: c.today })
    await invoice(s, { ...received(s), taxable_amount: '30', vat_amount: '0', due_date: c.end0 })
    // Next month, more to pay than to receive; the withholding is left out.
    await invoice(s, {
      ...received(s),
      taxable_amount: '2000',
      vat_amount: '440',
      withholding_amount: '400',
      due_date: c.d1,
    })
    await invoice(s, { taxable_amount: '0.01', vat_amount: '0', due_date: c.d1 })
    // Beyond a three-month horizon, and without a due date.
    await invoice(s, { taxable_amount: '700', vat_amount: '0', due_date: c.d3 })
    await invoice(s, { ...received(s), taxable_amount: '9.99', vat_amount: '0' })
    // Paid invoices never count.
    await invoice(s, { paid_on: c.long_ago, due_date: c.d2 })

    const res = await s.browser.call('GET', `${s.base}/cash-flow?months=3`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      today: c.today,
      overdue: { incoming: '1000.00', outgoing: '100.00', net: '900.00' },
      months: [
        { month: c.m0, incoming: '50.00', outgoing: '30.00', net: '20.00', balance: '920.00' },
        {
          month: c.m1,
          incoming: '0.01',
          outgoing: '2040.00',
          net: '-2039.99',
          balance: '-1119.99',
        },
        { month: c.m2, ...zero, balance: '-1119.99' },
      ],
      later: { incoming: '700.00', outgoing: '0.00', net: '700.00' },
      undated: { incoming: '0.00', outgoing: '9.99', net: '-9.99' },
      total: { incoming: '1750.01', outgoing: '2179.99', net: '-429.98' },
    })

    // Six months by default; one month only puts next month in later.
    const def = await s.browser.call('GET', `${s.base}/cash-flow`)
    expect(def.json<{ months: unknown[] }>().months).toHaveLength(6)
    const one = await s.browser.call('GET', `${s.base}/cash-flow?months=1`)
    expect(one.json()).toMatchObject({
      months: [{ month: c.m0, balance: '920.00' }],
      later: { incoming: '700.01', outgoing: '2040.00', net: '-1339.99' },
    })
    for (const bad of ['0', '25', 'sei', '1.5']) {
      const r = await s.browser.call('GET', `${s.base}/cash-flow?months=${bad}`)
      expect(r.statusCode).toBe(422)
      expect(r.json()).toMatchObject({ errors: { months: [expect.any(String)] } })
    }
  })

  it('sees only the invoices of its own company', async () => {
    const s = await scene()
    await invoice(s, { due_date: (await calendar()).d1 })
    const theirs = await scene()
    const res = await theirs.browser.call('GET', `${theirs.base}/cash-flow?months=2`)
    expect(res.json()).toMatchObject({ overdue: zero, months: [zero, zero], total: zero })
    expect((await theirs.browser.call('GET', `${s.base}/cash-flow`)).statusCode).toBe(404)
  })

  it('needs invoices.view and a session', async () => {
    const s = await scene(['clients.view'])
    expect((await s.browser.call('GET', `${s.base}/cash-flow`)).statusCode).toBe(403)
    const anon = new Browser(ctx.app)
    expect((await anon.call('GET', `${s.base}/cash-flow`)).statusCode).toBe(401)
  })
})
