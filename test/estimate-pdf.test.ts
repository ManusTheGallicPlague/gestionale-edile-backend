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

const ALL: Permission[] = ['estimates.view', 'estimates.create', 'estimates.update']

async function scene(permissions: Permission[] = ALL) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const client = await ctx.owner.query<{ id: string }>(
    "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Mario Bianchi') returning id",
    [company.id],
  )
  const estimate = await ctx.owner.query<{ id: string }>(
    `insert into public.estimates (company_id, title, client_id, site_address)
     values ($1, 'Villa (lotto 2)', $2, 'Via Roma 1, Asti') returning id`,
    [company.id, client.rows[0]?.id],
  )
  const estimateId = estimate.rows[0]?.id ?? ''
  const base = `/api/companies/${company.slug}/estimates/${estimateId}`
  const post = async <T>(path: string, body: Record<string, unknown>) => {
    const res = await browser.call('POST', `${base}/${path}`, { body })
    expect(res.statusCode).toBe(201)
    return res.json<T & { id: string }>()
  }
  const chapter = (title: string, code: string | null, parent_id: string | null = null) =>
    post('chapters', { code, title, parent_id })
  const item = (chapter_id: string, code: string, description: string, unit_price: string) =>
    post('items', { chapter_id, code, description, unit: 'm²', unit_price })
  const measure = (item_id: string, description: string | null, factors: (string | null)[]) =>
    post('measurements', {
      item_id,
      description,
      equal_parts: factors[0] ?? null,
      length: factors[1] ?? null,
      width: factors[2] ?? null,
      height: factors[3] ?? null,
    })
  return { browser, company, estimateId, base, chapter, item, measure }
}

describe('estimate pdf', () => {
  it('prints chapters, items with their measurements, totals and a summary', async () => {
    const s = await scene()
    const demolitions = await s.chapter('Demolizioni', 'A')
    const floors = await s.chapter('Pavimenti', 'A.1', demolitions.id)
    const plaster = await s.item(demolitions.id, 'A.01', 'Rimozione di intonaco', '8.5')
    await s.measure(plaster.id, 'Parete nord', ['2', '4.5', null, '3'])
    await s.measure(plaster.id, 'Porta', ['-1', '0.8', null, '2.1'])
    const tiles = await s.item(floors.id, 'A.02', 'Demolizione di pavimento', '12.5')
    await s.measure(tiles.id, 'Bagno', [null, '3.2', '2.5'])
    const paint = await s.chapter('Tinteggiature', null)
    await s.item(paint.id, 'B.01', 'Pittura lavabile', '1234.56')

    const pdf = await s.browser.call('GET', `${s.base}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="computo.pdf"')
    expect(pdf.headers['cache-control']).toContain('no-store')
    const text = pdf.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text).toContain('(Computo metrico estimativo)')
    expect(text).toContain('(Villa \\(lotto 2\\))')
    expect(text).toContain('(Committente: Mario Bianchi)')
    expect(text).toContain('(Luogo dei lavori: Via Roma 1, Asti)')
    expect(text).not.toContain('(Cantiere:')
    expect(text).toContain('(A Demolizioni)')
    expect(text).toContain('(A.1 Pavimenti)')
    expect(text).toContain('(A.01 Rimozione di intonaco)')
    expect(text).toContain('(Parete nord)')
    expect(text).toContain('(4,5)')
    // 2 × 4.5 × 3 = 27, the door −1 × 0.8 × 2.1 = −1.68, so 25.32 m² at € 8.50.
    expect(text).toContain('(-1,68)')
    expect(text).toContain('(Sommano m\xb2)')
    expect(text).toContain('(25,32)')
    expect(text).toContain('(215,22)')
    // 3.2 × 2.5 = 8 m² at € 12.50 = € 100, inside the sub-chapter.
    expect(text).toContain('(Totale Pavimenti)')
    expect(text).toContain('(100,00)')
    // The chapter adds up its sub-chapter: 215.22 + 100.
    expect(text).toContain('(Totale Demolizioni)')
    expect(text).toContain('(315,22)')
    // An item with no measurements: quantity 0.
    expect(text).toContain('(1.234,56)')
    expect(text).toContain('(Totale Tinteggiature)')
    expect(text).toContain('(\x80 315,22)')
    expect(text).toContain('(Riepilogo per capitoli)')
    expect(text).toContain('(Computo metrico estimativo \x96 pagina 1 di 1)')
    // Items are numbered in the order of the tree: A.01, then A.02 in the sub-chapter, B.01.
    const order = ['(A.01 Rimozione', '(A.02 Demolizione', '(B.01 Pittura'].map((t) =>
      text.indexOf(t),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('goes on more pages, with the table header on each', async () => {
    const s = await scene()
    const c = await s.chapter('Scavi', null)
    for (let i = 1; i <= 45; i++) {
      const it = await s.item(c.id, `S.${i}`, `Scavo a sezione obbligata n. ${i}`, '10')
      await s.measure(it.id, 'Tratto', ['1', '2'])
    }
    const text = (await s.browser.call('GET', `${s.base}/pdf`)).rawPayload.toString('latin1')
    const pages = /pagina 1 di (\d+)\)/.exec(text)?.[1]
    expect(Number(pages)).toBeGreaterThan(1)
    expect(text.split('(Par. ug.)').length - 1).toBe(Number(pages))
    expect(text).toContain('(\x80 900,00)')
  })

  it('is empty but valid with no chapters', async () => {
    const s = await scene()
    const pdf = await s.browser.call('GET', `${s.base}/pdf`)
    expect(pdf.statusCode).toBe(200)
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('(\x80 0,00)')
    expect(text).not.toContain('(Riepilogo per capitoli)')
  })

  it('answers 404 to another company, without permission and to a wrong id', async () => {
    const s = await scene()
    const theirs = await scene()
    const url = `/api/companies/${theirs.company.slug}/estimates/${s.estimateId}/pdf`
    expect((await theirs.browser.call('GET', url)).statusCode).toBe(404)
    // Their company in the path, my estimate: still 404, never another company's data.
    expect((await s.browser.call('GET', url)).statusCode).toBe(404)
    const wrong = `/api/companies/${s.company.slug}/estimates/not-a-uuid/pdf`
    expect((await s.browser.call('GET', wrong)).statusCode).toBe(404)

    const blind = await fx.companyWithUser(['quotes.view'])
    const browser = new Browser(ctx.app)
    await browser.signIn(blind.user.email)
    await fx.member(blind.user.id, s.company.id, await fx.role(s.company.id, 'Ospite', []))
    expect((await browser.call('GET', `${s.base}/pdf`)).statusCode).toBe(404)

    const anonymous = new Browser(ctx.app)
    expect((await anonymous.call('GET', `${s.base}/pdf`)).statusCode).toBe(401)
  })
})
