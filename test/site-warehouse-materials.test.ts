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
  'costs.view',
  'sites.view',
  'warehouse.view',
  'warehouse.create',
  'warehouse.update',
]

async function scene(permissions: Permission[] = ALL) {
  const { company } = await fx.companyWithUser(ALL)
  const user = await fx.user()
  await fx.member(user.id, company.id, await fx.role(company.id, 'Ufficio', ALL))
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const site = async (name: string) =>
    (
      await ctx.owner.query<{ id: string }>(
        'insert into public.sites (company_id, name) values ($1, $2) returning id',
        [company.id, name],
      )
    ).rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}`
  const s = {
    browser,
    company,
    base,
    site: await site('Villetta'),
    other: await site('Capannone'),
    summary: '',
  }
  s.summary = `${base}/sites/${s.site}/cost-summary`
  if (permissions !== ALL) {
    const reader = await fx.user()
    await fx.member(reader.id, company.id, await fx.role(company.id, 'Altro', permissions))
    const other = new Browser(ctx.app)
    await other.signIn(reader.email)
    return { ...s, browser: other, writer: browser }
  }
  return { ...s, writer: browser }
}

type Scene = Awaited<ReturnType<typeof scene>>

async function item(s: Scene, name: string) {
  const res = await s.writer.call('POST', `${s.base}/warehouse/items`, {
    body: { code: null, name, unit: 'sacchi', notes: null },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ id: string }>().id
}

async function move(
  s: Scene,
  itemId: string,
  kind: 'in' | 'out',
  quantity: string,
  date: string,
  extra: Record<string, unknown> = {},
) {
  const res = await s.writer.call('POST', `${s.base}/warehouse/movements`, {
    body: { item_id: itemId, date, kind, quantity, site_id: null, notes: null, ...extra },
  })
  expect(res.statusCode).toBe(201)
}

describe('warehouse materials in the cost summary of a site', () => {
  it('values the unloads to the site at the average cost up to their day', async () => {
    const s = await scene()
    const cement = await item(s, 'Cemento')
    const sand = await item(s, 'Sabbia')
    const gravel = await item(s, 'Ghiaia')

    // Unloaded before any load with a cost: counted, worth zero, missing a cost.
    await move(s, cement, 'out', '1', '2026-10-31', { site_id: s.site })
    await move(s, cement, 'in', '10', '2026-11-01', { unit_cost: '1.00' })
    // Average 1.00 on 2 November: 4.00.
    await move(s, cement, 'out', '4', '2026-11-02', { site_id: s.site })
    await move(s, cement, 'in', '10', '2026-11-05', { unit_cost: '2.00' })
    // Average 1.50 from 5 November: 4.50.
    await move(s, cement, 'out', '3', '2026-11-06', { site_id: s.site })
    // A later, dearer load (even one tied to the site) does not change past unloads,
    // and loads are not subtracted.
    await move(s, cement, 'in', '5', '2026-11-07', { unit_cost: '9.00', site_id: s.site })
    // To another site or to no site: not this site's.
    await move(s, cement, 'out', '2', '2026-11-06', { site_id: s.other })
    await move(s, cement, 'out', '1', '2026-11-06')
    // An item without costs: counted, worth zero.
    await move(s, sand, 'in', '5', '2026-11-01')
    await move(s, sand, 'out', '0.333', '2026-11-06', { site_id: s.site })
    // 0.1 + 0.2 at 1.00 averages exactly 1.00: 0.3 is worth 0.30.
    await move(s, gravel, 'in', '0.1', '2026-11-01', { unit_cost: '1.00' })
    await move(s, gravel, 'in', '0.2', '2026-11-01', { unit_cost: '1.00' })
    await move(s, gravel, 'out', '0.3', '2026-11-06', { site_id: s.site })

    const res = await s.browser.call('GET', s.summary)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      materials: '0.00',
      total: '0.00',
      warehouse_materials: { amount: '8.80', movements: 5, missing_costs: 2 },
    })

    // The other site sees only its own unload, at 1.50.
    const other = await s.browser.call('GET', `${s.base}/sites/${s.other}/cost-summary`)
    expect(other.json()).toMatchObject({
      warehouse_materials: { amount: '3.00', movements: 1, missing_costs: 0 },
    })
  })

  it('gives each movement its value, which adds up to the summary', async () => {
    const s = await scene()
    const cement = await item(s, 'Cemento')
    const sand = await item(s, 'Sabbia')
    await move(s, cement, 'out', '1', '2026-10-31', { site_id: s.site })
    // A value in the body is ignored: it is always computed.
    await move(s, cement, 'in', '10', '2026-11-01', { unit_cost: '1.25', value: '999.00' })
    await move(s, cement, 'out', '4', '2026-11-02', { site_id: s.site, value: '999.00' })
    await move(s, cement, 'in', '10', '2026-11-05', { unit_cost: '2.00' })
    await move(s, cement, 'out', '3', '2026-11-06', { site_id: s.site })
    await move(s, sand, 'in', '5', '2026-11-01')

    const list = await s.browser.call('GET', `${s.base}/warehouse/movements?per_page=100`)
    expect(list.statusCode).toBe(200)
    const values = list
      .json<{
        data: { date: string; kind: string; item: { name: string }; value: string | null }[]
      }>()
      .data.map((m) => [m.date, m.kind, m.item.name, m.value])
    expect(values).toEqual([
      // Average of 10 at 1.25 and 10 at 2.00: 1.625, so 3 × 1.625 = 4.875 → 4.88.
      ['2026-11-06', 'out', 'Cemento', '4.88'],
      ['2026-11-05', 'in', 'Cemento', '20.00'],
      ['2026-11-02', 'out', 'Cemento', '5.00'],
      ['2026-11-01', 'in', 'Sabbia', null],
      ['2026-11-01', 'in', 'Cemento', '12.50'],
      ['2026-10-31', 'out', 'Cemento', null],
    ])
    const summary = await s.browser.call('GET', s.summary)
    expect(summary.json()).toMatchObject({
      warehouse_materials: { amount: '9.88', movements: 3, missing_costs: 1 },
    })
  })

  it('rounds each unload to the cent', async () => {
    const s = await scene()
    const nails = await item(s, 'Chiodi')
    // Average of 0.01 and 0.02 is 1.5 cents: each unload of 1 rounds to 2 cents.
    await move(s, nails, 'in', '1', '2026-11-01', { unit_cost: '0.01' })
    await move(s, nails, 'in', '1', '2026-11-01', { unit_cost: '0.02' })
    await move(s, nails, 'out', '1', '2026-11-02', { site_id: s.site })
    await move(s, nails, 'out', '1', '2026-11-03', { site_id: s.site })
    const res = await s.browser.call('GET', s.summary)
    expect(res.json()).toMatchObject({
      warehouse_materials: { amount: '0.04', movements: 2, missing_costs: 0 },
    })
  })

  it('is zero for a site without unloads', async () => {
    const s = await scene()
    const res = await s.browser.call('GET', s.summary)
    expect(res.json()).toMatchObject({
      warehouse_materials: { amount: '0.00', movements: 0, missing_costs: 0 },
    })
  })

  it('is null without warehouse.view', async () => {
    const s = await scene(['costs.view', 'sites.view'])
    const cement = await item(s, 'Cemento')
    await move(s, cement, 'in', '10', '2026-11-01', { unit_cost: '1.00' })
    await move(s, cement, 'out', '4', '2026-11-02', { site_id: s.site })
    const res = await s.browser.call('GET', s.summary)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ warehouse_materials: null, total: '0.00' })
  })

  it('ignores the warehouse of another company and hides the site from it', async () => {
    const s = await scene()
    const cement = await item(s, 'Cemento')
    await move(s, cement, 'in', '10', '2026-11-01', { unit_cost: '1.00' })
    await move(s, cement, 'out', '4', '2026-11-02', { site_id: s.site })

    const intruder = await scene()
    // Its own item cannot be unloaded to this company's site.
    const theirs = await item(intruder, 'Cemento')
    await move(intruder, theirs, 'in', '10', '2026-11-01', { unit_cost: '5.00' })
    const res = await intruder.writer.call('POST', `${intruder.base}/warehouse/movements`, {
      body: {
        item_id: theirs,
        date: '2026-11-02',
        kind: 'out',
        quantity: '1',
        site_id: s.site,
        notes: null,
      },
    })
    expect(res.statusCode).toBe(422)
    // Nor can it read this site's summary through its own company.
    const peek = await intruder.browser.call('GET', `${intruder.base}/sites/${s.site}/cost-summary`)
    expect(peek.statusCode).toBe(404)

    const mine = await s.browser.call('GET', s.summary)
    expect(mine.json()).toMatchObject({
      warehouse_materials: { amount: '4.00', movements: 1, missing_costs: 0 },
    })
  })

  it('needs a session', async () => {
    const s = await scene()
    const res = await new Browser(ctx.app).call('GET', s.summary)
    expect(res.statusCode).toBe(401)
  })
})
