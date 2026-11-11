import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

async function scene() {
  const { company, user } = await fx.companyWithUser([
    'invoices.view',
    'invoices.create',
    'invoices.update',
  ])
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const one = async (sql: string) =>
    (await ctx.owner.query<{ id: string }>(sql, [company.id])).rows[0]?.id ?? ''
  const client = await one(
    "insert into public.clients (company_id, kind, name) values ($1, 'company', 'Comune di Prova') returning id",
  )
  const site = await one(
    `insert into public.sites (company_id, name, code, cig, cup)
       values ($1, 'Scuola', 'C-1', '12345ABCDE', 'B12C34000560007') returning id`,
  )
  const plain = await one(
    "insert into public.sites (company_id, name, code) values ($1, 'Villetta', 'C-2') returning id",
  )
  const invoices = `/api/companies/${company.slug}/invoices`
  for (const [number, siteId, amount] of [
    ['1/2026', site, '500'],
    ['2/2026', plain, '300'],
    ['3/2026', null, '200'],
  ] as const) {
    const created = await browser.call('POST', invoices, {
      body: {
        direction: 'issued',
        number,
        date: '2026-11-02',
        client_id: client,
        supplier_id: null,
        site_id: siteId,
        description: 'Lavori',
        taxable_amount: '1000',
        vat_amount: '100',
        due_date: null,
        paid_on: null,
        notes: null,
      },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ id: string }>().id
    const paid = await browser.call('POST', `${invoices}/${id}/payments`, {
      body: { date: '2026-11-05', amount, method: 'bank_transfer', notes: null },
      headers: { 'If-Match': '"1"' },
    })
    expect(paid.statusCode).toBe(200)
  }
  return { browser, company, payments: `/api/companies/${company.slug}/invoice-payments` }
}

type Scene = Awaited<ReturnType<typeof scene>>

interface Listed {
  data: {
    amount: string
    invoice: {
      number: string
      site: { name: string; cig: string | null; cup: string | null } | null
    }
  }[]
  meta: { total: number }
  collected: string
}

const list = async (s: Scene, query = '') => {
  const res = await s.browser.call('GET', `${s.payments}${query}`)
  expect(res.statusCode).toBe(200)
  return res.json<Listed>()
}

const lines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)

describe('CIG and CUP of the site in the payments ledger', () => {
  it('show the codes of the site of each invoice', async () => {
    const s = await scene()
    const sites = Object.fromEntries(
      (await list(s)).data.map((d) => [d.invoice.number, d.invoice.site]),
    )
    expect(sites['1/2026']).toMatchObject({
      name: 'Scuola',
      cig: '12345ABCDE',
      cup: 'B12C34000560007',
    })
    expect(sites['2/2026']).toMatchObject({ name: 'Villetta', cig: null, cup: null })
    expect(sites['3/2026']).toBeNull()
  })

  it('find the payments from the CIG or the CUP, whole, in part, lowercase or spaced', async () => {
    const s = await scene()
    for (const q of ['12345ABCDE', '345abc', 'B12C 3400 0560 007', 'b12c34000560007']) {
      const found = await list(s, `?filter[q]=${encodeURIComponent(q)}`)
      expect(found.data.map((d) => d.invoice.number)).toEqual(['1/2026'])
      // Totals follow the filter.
      expect(found.meta.total).toBe(1)
      expect(found.collected).toBe('500.00')
    }
    // Invoice number is searched as before.
    expect((await list(s, '?filter[q]=2%2F2026')).data.map((d) => d.invoice.number)).toEqual([
      '2/2026',
    ])
  })

  it('end the CSV with the CIG and CUP columns, following the filter', async () => {
    const s = await scene()
    const all = await s.browser.call('GET', `${s.payments}/export`)
    expect(all.statusCode).toBe(200)
    const [head, ...rows] = lines(all.body)
    expect(head).toMatch(/;Note;CIG;CUP$/)
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.includes(';1/2026;'))).toMatch(/;12345ABCDE;B12C34000560007$/)
    expect(rows.find((r) => r.includes(';2/2026;'))).toMatch(/;;$/)

    const found = await s.browser.call('GET', `${s.payments}/export?filter[q]=12345abcde`)
    expect(found.statusCode).toBe(200)
    expect(lines(found.body).slice(1)).toHaveLength(1)
  })

  it('do not find the payments of another company from its codes', async () => {
    const s = await scene()
    const stranger = await scene()
    await ctx.owner.query(
      `update public.sites set cig = 'ZZZZZ99999' where company_id = $1 and cig is not null`,
      [s.company.id],
    )
    expect((await list(stranger, '?filter[q]=ZZZZZ99999')).data).toEqual([])
    const csv = await stranger.browser.call(
      'GET',
      `${stranger.payments}/export?filter[q]=ZZZZZ99999`,
    )
    expect(lines(csv.body).slice(1)).toEqual([])
    const res = await stranger.browser.call('GET', `${s.payments}?filter[q]=ZZZZZ99999`)
    expect(res.statusCode).toBe(404)
  })
})
