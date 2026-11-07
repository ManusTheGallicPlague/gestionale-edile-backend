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

/** A company with quotes in every state, and a user with the given permissions. */
async function scene(permissions: Permission[] = ['quotes.view']) {
  const { company } = await fx.companyWithUser(['quotes.view'])
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Dashboard', permissions))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const id = company.id
  const clients = await ctx.owner.query<{ id: string }>(
    `insert into public.clients (company_id, kind, name, tax_code)
     values ($1, 'person', 'Cliente', 'RSSMRA80A01L219M') returning id`,
    [id],
  )
  const clientId = clients.rows[0]?.id
  let seq = 0
  /** A quote issued `issuedDaysAgo` days ago (a draft when status is draft). */
  const quote = async (
    status: string,
    issuedDaysAgo: number,
    options: {
      subject?: string
      revisionOf?: string
      revision?: number
      seq?: number
    } = {},
  ) => {
    const draft = status === 'draft'
    if (!draft && options.seq === undefined) seq += 1
    const { rows } = await ctx.owner.query<{ id: string }>(
      `insert into public.quotes (company_id, client_id, subject, validity_days, status,
         number_year, number_seq, revision, issue_date, sent_at, revision_of_id)
       values ($1, $2, $10, $3, $4, $5, $6, $7,
         case when $5::int is null then null
           else (now() at time zone 'Europe/Rome')::date - $8::int end,
         case when $5::int is null then null else now() end, $9)
       returning id`,
      [
        id,
        clientId,
        30,
        status,
        draft ? null : 2026,
        draft ? null : (options.seq ?? seq),
        draft ? null : (options.revision ?? 0),
        issuedDaysAgo,
        options.revisionOf ?? null,
        options.subject ?? 'Preventivo',
      ],
    )
    return rows[0]?.id ?? ''
  }
  const line = (quoteId: string, quantity: string, cents: number, discount = 0) =>
    ctx.owner.query(
      `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
         unit_price_cents, discount_percent, vat_rate, position)
       values ($1, $2, 'item', 'Voce', 'm2', $3, $4, $5, 22, 0)`,
      [id, quoteId, quantity, cents, discount],
    )

  await quote('draft', 0)
  // Valid for 10 more days; lines rounded one by one: 449.55 → 450 cents, twice.
  const a = await quote('sent', 20, { subject: 'Dieci giorni' })
  await line(a, '1.5', 333, 10)
  await line(a, '1.5', 333, 10)
  await ctx.owner.query(
    `insert into public.quote_lines (company_id, quote_id, kind, description, position)
     values ($1, $2, 'section', 'Capitolo', 1)`,
    [id, a],
  )
  await line(await quote('sent', 23, { subject: 'Sette giorni' }), '1', 10000) // Ends in 7 days: expiring.
  await quote('sent', 30, { subject: 'Oggi' }) // Ends today: expiring, no lines.
  await line(await quote('sent', 40, { subject: 'Finito' }), '1', 500) // Ended 10 days ago.
  // Replaced by a sent revision: only the revision is awaiting.
  const replaced = await quote('sent', 40, { subject: 'Sostituito' })
  await line(replaced, '1', 99999)
  const revision = await quote('sent', 0, {
    subject: 'Revisione',
    revisionOf: replaced,
    revision: 1,
    seq,
  })
  await line(revision, '1', 200)
  // A revision still in draft: the client still has the first one.
  const revising = await quote('sent', 1, { subject: 'In revisione' })
  await line(revising, '1', 100)
  await quote('draft', 0, { revisionOf: revising })
  await line(await quote('accepted', 5, { subject: 'Senza cantiere' }), '1', 77777)
  const withSite = await quote('accepted', 5)
  await ctx.owner.query(
    "insert into public.sites (company_id, name, quote_id) values ($1, 'Dal preventivo', $2)",
    [id, withSite],
  )
  await line(await quote('rejected', 5), '1', 1234)
  await quote('expired', 50)
  return { browser, company, url: `/api/companies/${company.slug}/dashboard` }
}

describe('quotes in the dashboard', () => {
  it('counts the quotes to follow up, only of the company', async () => {
    const s = await scene()
    await scene() // Another company with the same quotes must not double the counts.
    const res = await s.browser.call('GET', s.url)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ quotes: unknown }>().quotes).toEqual({
      drafts: 2,
      awaiting: 6,
      awaiting_taxable: '117.00',
      expiring: 2,
      past_validity: 1,
      accepted_without_site: 1,
    })
  })

  it('is null without quotes.view, and zero for a company without quotes', async () => {
    const blind = await scene(['sites.view'])
    expect(
      (await blind.browser.call('GET', blind.url)).json<{ quotes: unknown }>().quotes,
    ).toBeNull()
    const { company } = await fx.companyWithUser(['quotes.view'])
    const user = await fx.user()
    await fx.member(user.id, company.id, await fx.role(company.id, 'Vuota', ['quotes.view']))
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    const res = await browser.call('GET', `/api/companies/${company.slug}/dashboard`)
    expect(res.json<{ quotes: unknown }>().quotes).toEqual({
      drafts: 0,
      awaiting: 0,
      awaiting_taxable: '0.00',
      expiring: 0,
      past_validity: 0,
      accepted_without_site: 0,
    })
  })
})

describe('quotes to follow up in the list', () => {
  const subjects = async (
    s: Awaited<ReturnType<typeof scene>>,
    query: string,
  ): Promise<string[]> => {
    const res = await s.browser.call('GET', `/api/companies/${s.company.slug}/quotes?${query}`)
    expect(res.statusCode).toBe(200)
    return res.json<{ data: { subject: string }[] }>().data.map((q) => q.subject)
  }

  it('filters the same quotes the dashboard counts, by validity', async () => {
    const s = await scene()
    await scene()
    const byValidity = 'sort=valid_until&filter[follow_up]='
    expect(await subjects(s, `${byValidity}awaiting`)).toEqual([
      'Finito',
      'Oggi',
      'Sette giorni',
      'Dieci giorni',
      'In revisione',
      'Revisione',
    ])
    expect(await subjects(s, `${byValidity}expiring`)).toEqual(['Oggi', 'Sette giorni'])
    expect(await subjects(s, `${byValidity}past_validity`)).toEqual(['Finito'])
    expect(await subjects(s, `${byValidity}accepted_without_site`)).toEqual(['Senza cantiere'])
    const all = await subjects(s, 'sort=-valid_until&per_page=100')
    expect(all.slice(0, 2)).toEqual(['Revisione', 'In revisione'])
    expect(all.slice(-2)).toEqual(['Preventivo', 'Preventivo']) // The drafts, without validity.
    expect(await subjects(s, `${byValidity}awaiting&filter[status]=accepted`)).toEqual([])

    const csv = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/quotes/export?filter[follow_up]=expiring`,
    )
    expect(csv.statusCode).toBe(200)
    expect(csv.body.trim().split('\n')).toHaveLength(3)
    expect(csv.body).toContain('Sette giorni')
    expect(csv.body).toContain('Oggi')

    const wrong = await s.browser.call(
      'GET',
      `/api/companies/${s.company.slug}/quotes?filter[follow_up]=late`,
    )
    expect(wrong.statusCode).toBe(422)
    expect(wrong.json<{ errors: Record<string, string[]> }>().errors).toHaveProperty(
      'filter[follow_up]',
    )
  })
})
