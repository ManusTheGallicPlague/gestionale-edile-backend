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

const ALL: Permission[] = ['estimates.view', 'estimates.update', 'estimates.approve']

/** An estimate with two items: 100 m³ of excavation at 8.50 and 10 m² of plaster at 23.33. */
async function estimateOf(companyId: string) {
  const q = <T extends object>(sql: string, values: unknown[]) =>
    ctx.owner.query<T & { id: string }>(sql, values).then((r) => r.rows[0]?.id ?? '')
  const estimate = await q(
    "insert into public.estimates (company_id, title) values ($1, 'Villa') returning id",
    [companyId],
  )
  const chapter = await q(
    `insert into public.estimate_chapters (company_id, estimate_id, title, position)
     values ($1, $2, 'Opere', 0) returning id`,
    [companyId, estimate],
  )
  const item = (code: string, description: string, unit: string, cents: number, pos: number) =>
    q(
      `insert into public.estimate_items (company_id, estimate_id, chapter_id, code, description,
         unit, unit_price_cents, position) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [companyId, estimate, chapter, code, description, unit, cents, pos],
    )
  const scavo = await item('A.01', 'Scavo', 'm³', 850, 0)
  const intonaco = await item('B.01', 'Intonaco', 'm²', 2333, 1)
  await ctx.owner.query(
    `insert into public.estimate_measurements (company_id, estimate_id, item_id, equal_parts,
       position) values ($1, $2, $3, 100, 0), ($1, $2, $4, 10, 0)`,
    [companyId, estimate, scavo, intonaco],
  )
  return { estimate, chapter, scavo, intonaco }
}

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const e = await estimateOf(company.id)
  return {
    browser,
    company,
    ...e,
    url: `/api/companies/${company.slug}/estimates/${e.estimate}/progress-statements`,
  }
}

interface Line {
  item_id: string
  quantity: string
  previous_quantity: string
  cumulative_quantity: string
  contract_quantity: string
  unit_price: string
  amount: string
  previous_amount: string
  cumulative_amount: string
}
interface Statement {
  id: string
  number: number
  status: string
  amount: string
  previous_amount: string
  cumulative_amount: string
  lines: Line[]
}

describe('progress statements', () => {
  it('numbers the statements, adds up previous amounts and freezes approved ones', async () => {
    const s = await scene()
    const first = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        lines: [
          { item_id: s.scavo, quantity: '40' },
          { item_id: s.intonaco, quantity: '0.5' },
        ],
      },
    })
    expect(first.statusCode).toBe(201)
    const one = first.json<Statement>()
    expect(one).toMatchObject({ number: 1, status: 'draft', amount: '351.67' })
    // 0.5 × 23.33 = 11.665, rounded half away from zero.
    expect(one.lines.find((l) => l.item_id === s.intonaco)).toMatchObject({
      amount: '11.67',
      contract_quantity: '10.000',
      quantity: '0.500',
    })

    const again = await s.browser.call('POST', s.url, {
      body: { statement_date: '2026-11-30', notes: null, lines: [] },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'statement_draft_exists' })

    const oneUrl = `${s.url}/${one.id}`
    expect((await s.browser.call('POST', `${oneUrl}/approve`)).statusCode).toBe(428)
    const approved = await s.browser.call('POST', `${oneUrl}/approve`, {
      headers: { 'if-match': '"1"' },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json<Statement>().status).toBe('approved')
    const frozen = await s.browser.call('PUT', oneUrl, {
      body: { statement_date: '2026-10-31', notes: null, lines: [] },
      headers: { 'if-match': '"2"' },
    })
    expect(frozen.statusCode).toBe(409)
    expect(frozen.json()).toMatchObject({ code: 'statement_not_draft' })
    expect(
      (await s.browser.call('DELETE', oneUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(409)

    // A new price does not change the approved statement, only the next one.
    await ctx.owner.query('update public.estimate_items set unit_price_cents = 900 where id = $1', [
      s.scavo,
    ])
    const second = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-11-30',
        notes: 'Secondo',
        lines: [{ item_id: s.scavo, quantity: '10' }],
      },
    })
    expect(second.statusCode).toBe(201)
    const two = second.json<Statement>()
    expect(two).toMatchObject({
      number: 2,
      amount: '90.00',
      previous_amount: '351.67',
      cumulative_amount: '441.67',
    })
    expect(two.lines.find((l) => l.item_id === s.scavo)).toMatchObject({
      quantity: '10.000',
      previous_quantity: '40.000',
      cumulative_quantity: '50.000',
      unit_price: '9.00',
      previous_amount: '340.00',
      cumulative_amount: '430.00',
    })
    // The plaster has no line in this statement but appears with its previous quantity.
    expect(two.lines.find((l) => l.item_id === s.intonaco)).toMatchObject({
      quantity: '0.000',
      previous_quantity: '0.500',
      amount: '0.00',
    })
    expect((await s.browser.call('GET', oneUrl)).json<Statement>().amount).toBe('351.67')

    const twoUrl = `${s.url}/${two.id}`
    const edited = await s.browser.call('PUT', twoUrl, {
      body: {
        statement_date: '2026-11-30',
        notes: null,
        lines: [{ item_id: s.scavo, quantity: '-5' }],
      },
      headers: { 'if-match': '"1"' },
    })
    expect(edited.statusCode).toBe(200)
    expect(edited.json<Statement>().amount).toBe('-45.00')
    expect(
      (
        await s.browser.call('PUT', twoUrl, {
          body: { statement_date: '2026-11-30', notes: null, lines: [] },
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(412)
    const list = await s.browser.call('GET', s.url)
    expect(list.json<{ data: Statement[] }>().data.map((x) => [x.number, x.status])).toEqual([
      [1, 'approved'],
      [2, 'draft'],
    ])
    expect(
      (await s.browser.call('DELETE', twoUrl, { headers: { 'if-match': '"2"' } })).statusCode,
    ).toBe(204)
    expect((await s.browser.call('GET', s.url)).json<{ data: unknown[] }>().data).toHaveLength(1)
  })

  it('computes the retention, carried over to the next statement', async () => {
    const s = await scene()
    // 40 × 8.50 + 0.5 × 23.33 = 351.67; 5% = 17.5835 → 17.58.
    const first = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        retention_percent: '5',
        lines: [
          { item_id: s.scavo, quantity: '40' },
          { item_id: s.intonaco, quantity: '0.5' },
        ],
      },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      amount: '351.67',
      retention_percent: '5.00',
      retention_amount: '17.58',
      net_amount: '334.09',
    })
    const one = first.json<Statement>()
    // Absent on update: unchanged.
    const kept = await s.browser.call('PUT', `${s.url}/${one.id}`, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        lines: [{ item_id: s.scavo, quantity: '1' }],
      },
      headers: { 'if-match': '"1"' },
    })
    expect(kept.statusCode).toBe(200)
    // 8.50 × 5% = 0.425 → 0.43, half away from zero.
    expect(kept.json()).toMatchObject({
      amount: '8.50',
      retention_percent: '5.00',
      retention_amount: '0.43',
      net_amount: '8.07',
    })
    const bad = await s.browser.call('PUT', `${s.url}/${one.id}`, {
      body: { statement_date: '2026-10-31', notes: null, retention_percent: '100.5', lines: [] },
      headers: { 'if-match': '"2"' },
    })
    expect(bad.statusCode).toBe(422)
    expect(Object.keys(bad.json<{ errors: object }>().errors)).toEqual(['retention_percent'])
    const number = await s.browser.call('PUT', `${s.url}/${one.id}`, {
      body: { statement_date: '2026-10-31', notes: null, retention_percent: 5, lines: [] },
      headers: { 'if-match': '"2"' },
    })
    expect(number.statusCode).toBe(422)
    await s.browser.call('POST', `${s.url}/${one.id}/approve`, { headers: { 'if-match': '"2"' } })

    // The next statement takes the percentage of the previous one; a correction is negative.
    const second = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-11-30',
        notes: null,
        lines: [{ item_id: s.scavo, quantity: '-1' }],
      },
    })
    expect(second.statusCode).toBe(201)
    expect(second.json()).toMatchObject({
      amount: '-8.50',
      retention_percent: '5.00',
      retention_amount: '-0.43',
      net_amount: '-8.07',
    })
    const list = await s.browser.call('GET', s.url)
    expect(
      list.json<{ data: { retention_amount: string }[] }>().data.map((r) => r.retention_amount),
    ).toEqual(['0.43', '-0.43'])

    // A statement without retention, as the ones written before it existed.
    const other = await scene()
    const zero = await other.browser.call('POST', other.url, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        lines: [{ item_id: other.scavo, quantity: '2' }],
      },
    })
    expect(zero.json()).toMatchObject({
      retention_percent: '0.00',
      retention_amount: '0.00',
      net_amount: '17.00',
    })
  })

  it('prints the statement as a PDF, with retention and signatures', async () => {
    const s = await scene()
    await ctx.owner.query(
      "update public.estimates set site_address = 'Via Roma 1, Asti' where id = $1",
      [s.estimate],
    )
    const res = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-10-31',
        notes: 'Misure prese in contraddittorio.',
        retention_percent: '5',
        lines: [
          { item_id: s.scavo, quantity: '40' },
          { item_id: s.intonaco, quantity: '0.5' },
        ],
      },
    })
    const id = res.json<Statement>().id
    const pdf = await s.browser.call('GET', `${s.url}/${id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="sal-1.pdf"')
    const text = pdf.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain('(Stato di avanzamento lavori n. 1 \\(bozza, non ancora approvato\\))')
    expect(text).toContain('(Lavori eseguiti a tutto il 31/10/2026)')
    expect(text).toContain('(Computo: Villa)')
    expect(text).toContain('(Luogo dei lavori: Via Roma 1, Asti)')
    expect(text).toContain('(A.01 Scavo)')
    expect(text).toContain('(m\xb3)')
    expect(text).toContain('(0,5)')
    expect(text).toContain('(\x80 351,67)')
    expect(text).toContain('(Ritenuta di garanzia 5%)')
    expect(text).toContain('(\x80 17,58)')
    expect(text).toContain('(\x80 334,09)')
    expect(text).toContain('(Il direttore dei lavori)')
    expect(text).toContain('(SAL n. 1 \x96 pagina 1 di 1)')

    // Another company's statement, a statement under another estimate, no permission: 404.
    const theirs = await scene()
    expect((await theirs.browser.call('GET', `${theirs.url}/${id}/pdf`)).statusCode).toBe(404)
    const other = await estimateOf(s.company.id)
    const wrong = `/api/companies/${s.company.slug}/estimates/${other.estimate}/progress-statements/${id}/pdf`
    expect((await s.browser.call('GET', wrong)).statusCode).toBe(404)
    const blind = await fx.companyWithUser(['quotes.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(blind.user.email)
    await fx.member(blind.user.id, s.company.id, await fx.role(s.company.id, 'Ospite', []))
    const url = `/api/companies/${s.company.slug}/estimates/${s.estimate}/progress-statements/${id}/pdf`
    expect((await browser.call('GET', url)).statusCode).toBe(404)
  })

  it('keeps the estimate and the items of a statement', async () => {
    const s = await scene([...ALL, 'estimates.delete'])
    const statement = (
      await s.browser.call('POST', s.url, {
        body: {
          statement_date: '2026-10-31',
          notes: null,
          lines: [{ item_id: s.scavo, quantity: '5' }],
        },
      })
    ).json<Statement>()
    await s.browser.call('POST', `${s.url}/${statement.id}/approve`, {
      headers: { 'if-match': '"1"' },
    })
    const estimate = `/api/companies/${s.company.slug}/estimates/${s.estimate}`
    for (const url of [
      `${estimate}/items/${s.scavo}`,
      `${estimate}/chapters/${s.chapter}`,
      estimate,
    ]) {
      const res = await s.browser.call('DELETE', url, { headers: { 'if-match': '"1"' } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'has_documents' })
    }
    // An item outside the statements can still go.
    expect(
      (
        await s.browser.call('DELETE', `${estimate}/items/${s.intonaco}`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(204)
    const after = (await s.browser.call('GET', `${s.url}/${statement.id}`)).json<Statement>()
    expect(after).toMatchObject({ status: 'approved', amount: '42.50' })
  })

  it('does not stop the deletion of a whole company', async () => {
    const s = await scene()
    const created = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        lines: [{ item_id: s.scavo, quantity: '5' }],
      },
    })
    expect(created.statusCode).toBe(201)
    await ctx.owner.query('delete from public.companies where id = $1', [s.company.id])
    const left = await ctx.owner.query(
      'select 1 from public.progress_statement_lines where company_id = $1',
      [s.company.id],
    )
    expect(left.rowCount).toBe(0)
  })

  it.each([
    ['no date', { statement_date: null }],
    ['a bad date', { statement_date: '2026-13-01' }],
    ['lines not a list', { lines: {} }],
    ['a quantity as a number', { lines: [{ item_id: 'SCAVO', quantity: 1 }] }],
    ['a bad quantity', { lines: [{ item_id: 'SCAVO', quantity: '1.2345' }] }],
    [
      'a repeated item',
      {
        lines: [
          { item_id: 'SCAVO', quantity: '1' },
          { item_id: 'SCAVO', quantity: '2' },
        ],
      },
    ],
    ['an unknown item', { lines: [{ item_id: crypto.randomUUID(), quantity: '1' }] }],
  ])('refuses %s with 422', async (_, overrides) => {
    const s = await scene()
    const body = JSON.parse(
      JSON.stringify({
        statement_date: '2026-10-31',
        notes: null,
        lines: [],
        ...overrides,
      }).replaceAll('SCAVO', s.scavo),
    ) as unknown
    const res = await s.browser.call('POST', s.url, { body })
    expect(res.statusCode).toBe(422)
    expect((await s.browser.call('GET', s.url)).json<{ data: unknown[] }>().data).toEqual([])
  })

  it('does not take items of another estimate or another company', async () => {
    const s = await scene()
    const other = await estimateOf(s.company.id)
    const res = await s.browser.call('POST', s.url, {
      body: {
        statement_date: '2026-10-31',
        notes: null,
        lines: [{ item_id: other.scavo, quantity: '1' }],
      },
    })
    expect(res.statusCode).toBe(422)

    const theirs = await scene()
    const statement = (
      await s.browser.call('POST', s.url, {
        body: { statement_date: '2026-10-31', notes: null, lines: [] },
      })
    ).json<Statement>()
    const foreign = `/api/companies/${theirs.company.slug}/estimates/${s.estimate}/progress-statements`
    expect((await theirs.browser.call('GET', foreign)).statusCode).toBe(404)
    expect((await theirs.browser.call('GET', `${theirs.url}/${statement.id}`)).statusCode).toBe(404)
    expect(
      (
        await theirs.browser.call('POST', `${theirs.url}/${statement.id}/approve`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await theirs.browser.call('POST', theirs.url, {
          body: {
            statement_date: '2026-10-31',
            notes: null,
            lines: [{ item_id: s.scavo, quantity: '1' }],
          },
        })
      ).statusCode,
    ).toBe(422)
  })

  it('checks the permissions', async () => {
    const owner = await scene()
    const statement = (
      await owner.browser.call('POST', owner.url, {
        body: { statement_date: '2026-10-31', notes: null, lines: [] },
      })
    ).json<Statement>()
    const as = async (permissions: Permission[]) => {
      const user = await fx.user()
      await fx.member(
        user.id,
        owner.company.id,
        await fx.role(owner.company.id, permissions.join(' '), permissions),
      )
      const browser = new Browser(ctx.app)
      await browser.signIn(user.email)
      return browser
    }
    const editor = await as(['estimates.view', 'estimates.update'])
    expect(
      (
        await editor.call('POST', `${owner.url}/${statement.id}/approve`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(403)
    const viewer = await as(['estimates.view'])
    expect((await viewer.call('GET', `${owner.url}/${statement.id}`)).statusCode).toBe(200)
    expect(
      (
        await viewer.call('PUT', `${owner.url}/${statement.id}`, {
          body: { statement_date: '2026-10-31', notes: null, lines: [] },
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(403)
    const approver = await as(['estimates.approve'])
    expect((await approver.call('GET', owner.url)).statusCode).toBe(404)
    expect(
      (
        await approver.call('POST', `${owner.url}/${statement.id}/approve`, {
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(404)
  })
})
