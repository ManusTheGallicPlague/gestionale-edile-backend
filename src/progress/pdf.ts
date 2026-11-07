import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { companyHeader, italianAmount, italianQuantity, type QuotePdfData } from '../quotes/pdf.js'

export interface StatementPdfData {
  logo?: PdfImage | undefined
  company: QuotePdfData['company']
  estimate: { title: string; client: string | null; site: string | null; address: string | null }
  number: number
  statement_date: string
  status: 'draft' | 'approved'
  notes: string | null
  amount: string
  previous_amount: string
  cumulative_amount: string
  retention_percent: string
  retention_amount: string
  net_amount: string
  lines: {
    code: string | null
    description: string
    unit: string
    unit_price: string
    quantity: string
    previous_quantity: string
    cumulative_quantity: string
    amount: string
  }[]
}

const MARGIN = 42
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const BODY: TextStyle = { size: 9 }
const BOLD: TextStyle = { size: 9, bold: true }
const LEADING = 12

// Right edges of the columns; the description takes what is left.
const COLUMNS = { unit: 290, price: 345, previous: 400, quantity: 450, cumulative: 500 }
const DESCRIPTION_WIDTH = 215

const italianDate = (date: string) => date.split('-').reverse().join('/')

/** The progress statement in A4: items with quantities and amounts, totals, signatures. */
export function statementPdf(data: StatementPdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const tableHeader = () => {
    const row = y - 10
    pdf.text(MARGIN, row, 'Voce', BOLD)
    pdf.textRight(COLUMNS.unit, row, 'U.M.', BOLD)
    pdf.textRight(COLUMNS.price, row, 'Prezzo', BOLD)
    pdf.textRight(COLUMNS.previous, row, 'Q.tà prec.', BOLD)
    pdf.textRight(COLUMNS.quantity, row, 'Q.tà SAL', BOLD)
    pdf.textRight(COLUMNS.cumulative, row, 'Q.tà progr.', BOLD)
    pdf.textRight(RIGHT, row, 'Importo SAL', BOLD)
    pdf.line(MARGIN, row - 4, RIGHT, row - 4)
    y = row - 4 - LEADING
  }
  const paragraph = (text: string, style: TextStyle) => {
    for (const line of wrap(text, RIGHT - MARGIN, style)) {
      if (y - LEADING < BOTTOM) newPage()
      pdf.text(MARGIN, y, line, style)
      y -= LEADING
    }
  }

  newPage()
  const header = companyHeader(pdf, data.logo, data.company, y)
  y = header.bottom - 12
  const title =
    data.status === 'approved'
      ? `Stato di avanzamento lavori n. ${data.number}`
      : `Stato di avanzamento lavori n. ${data.number} (bozza, non ancora approvato)`
  pdf.text(MARGIN, y, title, { size: 12, bold: true })
  y -= LEADING + 4
  paragraph(`Lavori eseguiti a tutto il ${italianDate(data.statement_date)}`, BODY)
  const e = data.estimate
  paragraph(`Computo: ${e.title}`, BOLD)
  for (const [label, value] of [
    ['Committente', e.client],
    ['Cantiere', e.site],
    ['Luogo dei lavori', e.address],
  ] as const) {
    if (value) paragraph(`${label}: ${value}`, BODY)
  }
  y -= 6

  tableHeader()
  for (const line of data.lines) {
    const text = line.code ? `${line.code} ${line.description}` : line.description
    const rows = wrap(text, DESCRIPTION_WIDTH, BODY)
    if (y - rows.length * LEADING < BOTTOM) {
      newPage()
      tableHeader()
    }
    const top = y
    for (const row of rows) {
      pdf.text(MARGIN, y, row, BODY)
      y -= LEADING
    }
    pdf.textRight(COLUMNS.unit, top, line.unit, BODY)
    pdf.textRight(COLUMNS.price, top, italianAmount(line.unit_price), BODY)
    pdf.textRight(COLUMNS.previous, top, italianQuantity(line.previous_quantity), BODY)
    pdf.textRight(COLUMNS.quantity, top, italianQuantity(line.quantity), BODY)
    pdf.textRight(COLUMNS.cumulative, top, italianQuantity(line.cumulative_quantity), BODY)
    pdf.textRight(RIGHT, top, italianAmount(line.amount), BODY)
  }

  // Totals, kept together on one page.
  if (y - (5 * LEADING + 20) < BOTTOM) newPage()
  pdf.line(MARGIN, y + 4, RIGHT, y + 4)
  y -= 8
  const total = (label: string, value: string, style: TextStyle) => {
    pdf.textRight(RIGHT - 90, y, label, style)
    pdf.textRight(RIGHT, y, `€ ${italianAmount(value)}`, style)
    y -= LEADING
  }
  total('Lavori a tutto il presente SAL', data.cumulative_amount, BODY)
  total('A dedurre i SAL precedenti', data.previous_amount, BODY)
  total('Importo dei lavori di questo SAL', data.amount, BOLD)
  const retention = italianQuantity(data.retention_percent)
  if (data.retention_percent !== '0.00') {
    total(`Ritenuta di garanzia ${retention}%`, data.retention_amount, BODY)
    total('Importo netto di questo SAL', data.net_amount, { size: 11, bold: true })
  }
  y -= LEADING
  if (data.notes) {
    paragraph('Note', BOLD)
    paragraph(data.notes, BODY)
  }

  y -= 24
  if (y - 3 * LEADING < BOTTOM) newPage()
  pdf.text(MARGIN, y, 'Il direttore dei lavori', BODY)
  pdf.text(RIGHT - 220, y, "L'impresa", BODY)
  pdf.line(MARGIN, y - 28, MARGIN + 200, y - 28)
  pdf.line(RIGHT - 220, y - 28, RIGHT, y - 28)

  // Page numbers, now that the count is known.
  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `SAL n. ${data.number} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
