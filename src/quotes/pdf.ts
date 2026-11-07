import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { VAT_NATURES, isVatNature } from './vat.js'

export interface QuotePdfData {
  logo?: PdfImage | undefined
  company: {
    legal_name: string
    vat_number: string | null
    tax_code: string | null
    rea: string | null
    share_capital: string | null
    street: string | null
    postal_code: string | null
    city: string | null
    province: string | null
    phone: string | null
    email: string | null
    pec: string | null
    iban: string | null
  }
  client: {
    name: string
    vat_number: string | null
    tax_code: string | null
    street: string | null
    postal_code: string | null
    city: string | null
    province: string | null
  }
  number: string | null
  issue_date: string | null
  valid_until: string | null
  validity_days: number
  subject: string
  notes: string | null
  terms: string | null
  lines: {
    kind: 'item' | 'text' | 'section'
    description: string
    unit: string | null
    quantity: string | null
    unit_price: string | null
    discount_percent: string | null
    vat_rate: number | null
    vat_nature: string | null
    amount: string | null
  }[]
  totals: {
    taxable: string
    vat: { rate: number; nature: string | null; taxable: string; vat: string }[]
    total: string
  }
}

const MARGIN = 42
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const BODY: TextStyle = { size: 9 }
const BOLD: TextStyle = { size: 9, bold: true }
const LEADING = 12

// Columns of the lines table: right edges, the description takes what is left.
const COLUMNS = {
  description: MARGIN,
  unit: 318,
  quantity: 372,
  price: 432,
  discount: 470,
  vat: 498,
  amount: RIGHT,
}
const DESCRIPTION_WIDTH = 270

/** "1234.50" → "1.234,50"; the sign stays in front. */
export function italianAmount(value: string): string {
  const negative = value.startsWith('-')
  const [whole = '0', cents = '00'] = value.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${negative ? '-' : ''}${grouped},${cents}`
}

/** "120.500" → "120,5"; "3.000" → "3". */
export function italianQuantity(value: string): string {
  const [whole = '0', decimals = ''] = value.split('.')
  const trimmed = decimals.replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return trimmed ? `${grouped},${trimmed}` : grouped
}

const italianDate = (date: string) => date.split('-').reverse().join('/')

export function quotePdf(data: QuotePdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const need = (height: number) => {
    if (y - height < BOTTOM) {
      newPage()
      tableHeader()
    }
  }
  const tableHeader = () => {
    const row = y - 10
    pdf.text(COLUMNS.description, row, 'Descrizione', BOLD)
    pdf.textRight(COLUMNS.unit, row, 'U.M.', BOLD)
    pdf.textRight(COLUMNS.quantity, row, 'Quantità', BOLD)
    pdf.textRight(COLUMNS.price, row, 'Prezzo', BOLD)
    pdf.textRight(COLUMNS.discount, row, 'Sc. %', BOLD)
    pdf.textRight(COLUMNS.vat, row, 'IVA', BOLD)
    pdf.textRight(COLUMNS.amount, row, 'Importo', BOLD)
    pdf.line(MARGIN, row - 4, RIGHT, row - 4)
    y = row - 4 - LEADING
  }
  const paragraph = (text: string, style: TextStyle, width = RIGHT - MARGIN) => {
    for (const line of wrap(text, width, style)) {
      if (y - LEADING < BOTTOM) newPage()
      pdf.text(MARGIN, y, line, style)
      y -= LEADING
    }
  }

  newPage()
  // Header: who sends, the quote, who receives.
  const co = data.company
  if (data.logo) {
    // At most 150 × 50 points, keeping the proportions.
    const scale = Math.min(150 / data.logo.width, 50 / data.logo.height)
    const height = data.logo.height * scale
    pdf.image(data.logo, MARGIN, y - height, data.logo.width * scale, height)
    y -= height + 8
  }
  pdf.text(MARGIN, y - 14, co.legal_name, { size: 14, bold: true })
  const small: TextStyle = { size: 8 }
  const companyLines = [
    [
      co.street,
      [co.postal_code, co.city, co.province ? `(${co.province})` : null].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .join(' – '),
    [
      co.vat_number ? `P. IVA ${co.vat_number}` : null,
      co.tax_code && co.tax_code !== co.vat_number ? `C.F. ${co.tax_code}` : null,
    ]
      .filter(Boolean)
      .join(' – '),
    [
      co.rea ? `REA ${co.rea}` : null,
      co.share_capital ? `Cap. soc. € ${italianAmount(co.share_capital)} i.v.` : null,
    ]
      .filter(Boolean)
      .join(' – '),
    [co.phone ? `Tel. ${co.phone}` : null, co.email, co.pec ? `PEC ${co.pec}` : null]
      .filter(Boolean)
      .join(' – '),
  ].filter((line) => line !== '')
  let companyY = y - 26
  for (const text of companyLines) {
    for (const line of wrap(text, 280, small)) {
      pdf.text(MARGIN, companyY, line, small)
      companyY -= 10
    }
  }
  const title = data.number
    ? `Preventivo n. ${data.number} del ${italianDate(data.issue_date ?? '')}`
    : 'Preventivo (bozza, non ancora inviato)'
  pdf.text(MARGIN, companyY - 12, title, { size: 12, bold: true })
  let clientY = y - 14
  const clientX = 340
  pdf.text(clientX, clientY, 'Spett.le', BODY)
  clientY -= LEADING
  const c = data.client
  const place = [c.postal_code, c.city, c.province ? `(${c.province})` : null]
    .filter(Boolean)
    .join(' ')
  const ids = [
    c.vat_number ? `P. IVA ${c.vat_number}` : null,
    c.tax_code ? `C.F. ${c.tax_code}` : null,
  ]
  for (const [index, text] of [c.name, c.street, place, ...ids].entries()) {
    if (!text) continue
    for (const line of wrap(text, RIGHT - clientX, index === 0 ? BOLD : BODY)) {
      pdf.text(clientX, clientY, line, index === 0 ? BOLD : BODY)
      clientY -= LEADING
    }
  }
  y = Math.min(companyY - 30, clientY - 8)
  paragraph(`Oggetto: ${data.subject}`, BOLD)
  y -= 6

  tableHeader()
  for (const line of data.lines) {
    if (line.kind === 'section') {
      const rows = wrap(line.description, RIGHT - MARGIN, BOLD)
      need(rows.length * LEADING + 6)
      y -= 4
      for (const row of rows) {
        pdf.text(MARGIN, y, row, BOLD)
        y -= LEADING
      }
      continue
    }
    const rows = wrap(
      line.description,
      line.kind === 'text' ? RIGHT - MARGIN : DESCRIPTION_WIDTH,
      BODY,
    )
    need(rows.length * LEADING)
    const top = y
    for (const row of rows) {
      pdf.text(MARGIN, y, row, BODY)
      y -= LEADING
    }
    if (line.kind === 'item') {
      pdf.textRight(COLUMNS.unit, top, line.unit ?? '', BODY)
      pdf.textRight(COLUMNS.quantity, top, italianQuantity(line.quantity ?? '0'), BODY)
      pdf.textRight(COLUMNS.price, top, italianAmount(line.unit_price ?? '0.00'), BODY)
      const discount = italianQuantity(line.discount_percent ?? '0')
      pdf.textRight(COLUMNS.discount, top, discount === '0' ? '' : discount, BODY)
      pdf.textRight(COLUMNS.vat, top, line.vat_nature ?? `${line.vat_rate ?? 0}%`, BODY)
      pdf.textRight(COLUMNS.amount, top, italianAmount(line.amount ?? '0.00'), BODY)
    }
  }

  // Totals, kept together on one page.
  const totalRows = 2 + data.totals.vat.length
  if (y - (totalRows * LEADING + 20) < BOTTOM) newPage()
  pdf.line(MARGIN, y + 4, RIGHT, y + 4)
  y -= 8
  const total = (label: string, value: string, style: TextStyle) => {
    pdf.textRight(COLUMNS.amount - 90, y, label, style)
    pdf.textRight(COLUMNS.amount, y, `€ ${italianAmount(value)}`, style)
    y -= LEADING
  }
  total('Imponibile', data.totals.taxable, BODY)
  for (const vat of data.totals.vat) {
    const rate = vat.nature ? `${vat.rate}% ${vat.nature}` : `${vat.rate}%`
    total(`IVA ${rate} su € ${italianAmount(vat.taxable)}`, vat.vat, BODY)
  }
  total('Totale', data.totals.total, { size: 11, bold: true })
  y -= LEADING

  // The wording of each nature, as the law wants it written on the document.
  for (const vat of data.totals.vat) {
    if (vat.nature && isVatNature(vat.nature)) {
      paragraph(`${vat.nature}: ${VAT_NATURES[vat.nature]}.`, BODY)
    }
  }

  const validity = data.valid_until
    ? `Validità dell'offerta: ${data.validity_days} giorni, fino al ${italianDate(data.valid_until)}.`
    : `Validità dell'offerta: ${data.validity_days} giorni dalla data del preventivo.`
  paragraph(validity, BODY)
  for (const [label, text] of [
    ['Note', data.notes],
    ['Condizioni', data.terms],
  ] as const) {
    if (!text) continue
    y -= 6
    paragraph(label, BOLD)
    paragraph(text, BODY)
  }
  if (co.iban) {
    y -= 6
    paragraph(`Pagamento su IBAN ${co.iban}`, BODY)
  }
  y -= 24
  if (y - 3 * LEADING < BOTTOM) newPage()
  pdf.text(MARGIN, y, 'Per accettazione (data, timbro e firma)', BODY)
  pdf.line(MARGIN, y - 28, MARGIN + 220, y - 28)

  // Page numbers, now that the count is known.
  const label = data.number ? `Preventivo ${data.number}` : 'Preventivo in bozza'
  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `${label} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
