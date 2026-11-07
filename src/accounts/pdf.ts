import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { companyHeader, italianAmount, type QuotePdfData } from '../quotes/pdf.js'

export interface AccountPdfData {
  logo?: PdfImage | undefined
  company: QuotePdfData['company']
  client: QuotePdfData['client']
  today: string
  outstanding: string
  overdue: string
  invoices: {
    number: string
    date: string
    due_date: string | null
    overdue: boolean
    amount_due: string
    settled: string
    remaining: string
  }[]
}

const MARGIN = 42
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const BODY: TextStyle = { size: 9 }
const BOLD: TextStyle = { size: 9, bold: true }
const LEADING = 12

// Left edges of the first columns, right edges of the amounts.
const COLUMNS = { date: 150, due: 215, amountDue: 400, settled: 475 }

const italianDate = (date: string) => date.split('-').reverse().join('/')

/** The open items of a client in A4, to send as a payment reminder. */
export function accountPdf(data: AccountPdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const tableHeader = () => {
    const row = y - 10
    pdf.text(MARGIN, row, 'Fattura', BOLD)
    pdf.text(COLUMNS.date, row, 'Data', BOLD)
    pdf.text(COLUMNS.due, row, 'Scadenza', BOLD)
    pdf.textRight(COLUMNS.amountDue, row, 'Netto a pagare', BOLD)
    pdf.textRight(COLUMNS.settled, row, 'Già incassato', BOLD)
    pdf.textRight(RIGHT, row, 'Residuo', BOLD)
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
  pdf.text(MARGIN, y, 'Estratto conto', { size: 12, bold: true })
  y -= LEADING + 4
  paragraph(`Situazione al ${italianDate(data.today)}`, BODY)

  const c = data.client
  paragraph('Spett.le', BODY)
  paragraph(c.name, BOLD)
  if (c.street) paragraph(c.street, BODY)
  const place = [c.postal_code, c.city, c.province ? `(${c.province})` : null]
    .filter(Boolean)
    .join(' ')
  if (place) paragraph(place, BODY)
  if (c.vat_number) paragraph(`P. IVA ${c.vat_number}`, BODY)
  else if (c.tax_code) paragraph(`C.F. ${c.tax_code}`, BODY)
  y -= 6

  if (data.invoices.length === 0) {
    paragraph('Nessuna fattura da incassare.', BODY)
  } else {
    paragraph('Le fatture seguenti risultano ancora da saldare.', BODY)
    y -= 4
    tableHeader()
    for (const inv of data.invoices) {
      const rows = wrap(inv.number, COLUMNS.date - MARGIN - 6, BODY)
      if (y - rows.length * LEADING < BOTTOM) {
        newPage()
        tableHeader()
      }
      const top = y
      for (const row of rows) {
        pdf.text(MARGIN, y, row, BODY)
        y -= LEADING
      }
      pdf.text(COLUMNS.date, top, italianDate(inv.date), BODY)
      if (inv.due_date) {
        const due = italianDate(inv.due_date)
        pdf.text(COLUMNS.due, top, inv.overdue ? `${due} scaduta` : due, inv.overdue ? BOLD : BODY)
      }
      pdf.textRight(COLUMNS.amountDue, top, italianAmount(inv.amount_due), BODY)
      pdf.textRight(COLUMNS.settled, top, italianAmount(inv.settled), BODY)
      pdf.textRight(RIGHT, top, italianAmount(inv.remaining), BODY)
    }
    if (y - (3 * LEADING + 20) < BOTTOM) newPage()
    pdf.line(MARGIN, y + 4, RIGHT, y + 4)
    y -= 8
    pdf.textRight(RIGHT - 90, y, 'Totale da incassare', { size: 11, bold: true })
    pdf.textRight(RIGHT, y, `€ ${italianAmount(data.outstanding)}`, { size: 11, bold: true })
    y -= LEADING + 2
    pdf.textRight(RIGHT - 90, y, 'di cui scaduto', BODY)
    pdf.textRight(RIGHT, y, `€ ${italianAmount(data.overdue)}`, BODY)
    y -= 2 * LEADING
    if (data.company.iban) paragraph(`Per il pagamento: IBAN ${data.company.iban}`, BODY)
    paragraph('Se il pagamento è già stato fatto, non tenete conto di questo avviso.', BODY)
  }

  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `Estratto conto ${c.name} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
