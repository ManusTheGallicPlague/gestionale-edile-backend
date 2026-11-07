import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { italianAmount, italianQuantity } from '../src/quotes/pdf.js'
import { textWidth, wrap } from '../src/pdf/pdf.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

function newVat(): string {
  const first10 = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  return first10 + partitaIvaCheckDigit(first10)
}

async function scene(
  permissions: Permission[] = ['quotes.view', 'quotes.create', 'quotes.update'],
) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const vat = newVat()
  const client = await ctx.owner.query<{ id: string }>(
    `insert into public.clients (company_id, kind, name, vat_number, street, postal_code, city, province)
     values ($1, 'company', 'Condominio Aurora (scala B)', $2, 'Via dei Mille 4', '10121', 'Torino', 'TO')
     returning id`,
    [company.id, vat],
  )
  const base = `/api/companies/${company.slug}/quotes`
  const res = await browser.call('POST', base, {
    body: {
      client_id: client.rows[0]?.id,
      subject: 'Rifacimento del tetto – lotto 2',
      validity_days: 30,
      notes: 'Sopralluogo del 3 novembre.',
      terms: 'Pagamento: 30% all’ordine, saldo a fine lavori. 🙂',
    },
  })
  const quote = res.json<{ id: string }>()
  const addLine = (body: object) => browser.call('POST', `${base}/${quote.id}/lines`, { body })
  return { browser, company, base, quote, addLine, vat }
}

const item = (overrides: object = {}) => ({
  kind: 'item',
  description: 'Manto in coppi di recupero',
  unit: 'm²',
  quantity: '1200.5',
  unit_price: '45.00',
  discount_percent: '0',
  vat_rate: 10,
  ...overrides,
})

/** The PDF as text (every byte is one Latin-1 character), checked for a sound structure. */
function readPdf(body: Buffer): string {
  const text = body.toString('latin1')
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.endsWith('%%EOF\n')).toBe(true)
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1])
  expect(text.slice(startxref, startxref + 4)).toBe('xref')
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
    Number(m[1]),
  )
  offsets.forEach((offset, i) => {
    expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`)
  })
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = (match.index ?? 0) + match[0].length
    expect(text.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe('\nendstream')
  }
  return text
}

describe('quote PDF', () => {
  it('prints a sent quote with number, client, lines and totals', async () => {
    const { browser, base, quote, addLine, vat } = await scene()
    await addLine({
      ...item(),
      kind: 'section',
      description: 'Copertura',
      unit: null,
      quantity: null,
      unit_price: null,
      discount_percent: null,
      vat_rate: null,
    })
    await addLine(item())
    await addLine(
      item({
        description: 'Lattoneria',
        unit: 'm',
        quantity: '10',
        unit_price: '20.00',
        discount_percent: '12.5',
        vat_rate: 22,
      }),
    )
    const sent = await browser.call('POST', `${base}/${quote.id}/send`, {
      headers: { 'if-match': '"1"' },
    })
    const number = sent.json<{ number: string }>().number
    const res = await browser.call('GET', `${base}/${quote.id}/pdf`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="preventivo-${number.replace('/', '-')}.pdf"`,
    )
    const text = readPdf(res.rawPayload)
    expect(text).toContain(`(Preventivo n. ${number} del `)
    // Parentheses are escaped, the dash and the apostrophe are WinAnsi, the emoji is not.
    expect(text).toContain('(Condominio Aurora \\(scala B\\))')
    expect(text).toContain('(Oggetto: Rifacimento del tetto \x96 lotto 2)')
    expect(text).toContain('all\x92ordine')
    expect(text).toContain('fine lavori. ?)')
    expect(text).toContain(`(P. IVA ${vat})`)
    expect(text).toContain('(10121 Torino \\(TO\\))')
    expect(text).toContain('(m\xb2)')
    // 1200.5 × 45 = 54022.50; 10 × 20 × 0.875 = 175.00; IVA 5402.25 + 38.50.
    expect(text).toContain('(1.200,5)')
    expect(text).toContain('(54.022,50)')
    expect(text).toContain('(12,5)')
    expect(text).toContain('(\x80 54.197,50)')
    expect(text).toContain('(\x80 59.638,25)')
    expect(text).toContain('pagina 1 di 1)')
  })

  it('prints the VAT nature on the line, in the totals and in words', async () => {
    const { browser, base, quote, addLine } = await scene()
    await addLine(item({ vat_rate: 0, vat_nature: 'N6.7' }))
    const res = await browser.call('GET', `${base}/${quote.id}/pdf`)
    expect(res.statusCode).toBe(200)
    const text = readPdf(res.rawPayload)
    expect(text).toContain('(N6.7)')
    expect(text).toContain('(IVA 0% N6.7 su \x80 54.022,50)')
    expect(text).toContain('(N6.7: Inversione contabile, prestazioni comparto edile')
  })

  it('prints a draft without number, over more pages', async () => {
    const { browser, base, quote, addLine } = await scene()
    for (let i = 0; i < 70; i++) {
      await addLine(item({ description: `Voce ${i + 1}: ${'descrizione lunga '.repeat(6)}` }))
    }
    const res = await browser.call('GET', `${base}/${quote.id}/pdf`)
    expect(res.headers['content-disposition']).toBe('attachment; filename="preventivo-bozza.pdf"')
    const text = readPdf(res.rawPayload)
    expect(text).toContain('(Preventivo \\(bozza, non ancora inviato\\))')
    const pages = Number(/\/Count (\d+)/.exec(text)?.[1])
    expect(pages).toBeGreaterThan(1)
    expect(text).toContain(`pagina ${pages} di ${pages})`)
    expect(text).toContain('(Voce 70:')
  })

  it('needs quotes.view and the same company', async () => {
    const mine = await scene()
    const url = `${mine.base}/${mine.quote.id}/pdf`
    const theirs = await scene()
    expect(
      (await theirs.browser.call('GET', `${theirs.base}/${mine.quote.id}/pdf`)).statusCode,
    ).toBe(404)
    const blind = await scene(['quotes.create'])
    expect((await blind.browser.call('GET', `${blind.base}/${mine.quote.id}/pdf`)).statusCode).toBe(
      404,
    )
    expect((await new Browser(ctx.app).call('GET', url)).statusCode).toBe(401)
  })
})

describe('PDF text', () => {
  it('formats amounts and quantities the Italian way', () => {
    expect(italianAmount('1234567.80')).toBe('1.234.567,80')
    expect(italianAmount('-0.05')).toBe('-0,05')
    expect(italianQuantity('120.500')).toBe('120,5')
    expect(italianQuantity('-3.000')).toBe('-3')
    expect(italianQuantity('1000.250')).toBe('1.000,25')
  })

  it('wraps text within the width, cutting words that do not fit', () => {
    const style = { size: 10 }
    const lines = wrap(`Prima riga\n${'parola '.repeat(30)}${'x'.repeat(80)}`, 100, style)
    expect(lines[0]).toBe('Prima riga')
    for (const line of lines) expect(textWidth(line, style)).toBeLessThanOrEqual(100)
    expect(lines.join('')).toContain('x'.repeat(10))
  })
})
