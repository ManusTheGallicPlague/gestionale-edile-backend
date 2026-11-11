import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { companyHeader, italianAmount, italianQuantity, type QuotePdfData } from '../quotes/pdf.js'

export interface OrderPdfData {
  logo?: PdfImage | undefined
  company: QuotePdfData['company']
  supplier: QuotePdfData['client']
  number: string
  status: 'draft' | 'sent' | 'received'
  date: string
  delivery_date: string | null
  site: { name: string; address: string | null; cig: string | null; cup: string | null } | null
  notes: string | null
  total: string
  lines: {
    description: string
    unit: string | null
    quantity: string
    unit_price: string
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
const COLUMNS = { unit: 345, quantity: 410, price: 480 }
const DESCRIPTION_WIDTH = 270

const italianDate = (date: string) => date.split('-').reverse().join('/')

/** The purchase order in A4, to send to the supplier: lines, total without VAT, notes. */
export function orderPdf(data: OrderPdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const tableHeader = () => {
    const row = y - 10
    pdf.text(MARGIN, row, 'Descrizione', BOLD)
    pdf.textRight(COLUMNS.unit, row, 'U.M.', BOLD)
    pdf.textRight(COLUMNS.quantity, row, 'Quantità', BOLD)
    pdf.textRight(COLUMNS.price, row, 'Prezzo', BOLD)
    pdf.textRight(RIGHT, row, 'Importo', BOLD)
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
    data.status === 'draft'
      ? `Ordine n. ${data.number} (bozza, non ancora inviato)`
      : `Ordine n. ${data.number}`
  pdf.text(MARGIN, y, title, { size: 12, bold: true })
  y -= LEADING + 4
  paragraph(`Data: ${italianDate(data.date)}`, BODY)

  const s = data.supplier
  paragraph('Spett.le', BODY)
  paragraph(s.name, BOLD)
  if (s.street) paragraph(s.street, BODY)
  const place = [s.postal_code, s.city, s.province ? `(${s.province})` : null]
    .filter(Boolean)
    .join(' ')
  if (place) paragraph(place, BODY)
  if (s.vat_number) paragraph(`P. IVA ${s.vat_number}`, BODY)
  else if (s.tax_code) paragraph(`C.F. ${s.tax_code}`, BODY)
  y -= 6
  if (data.site) {
    const where = data.site.address ? `${data.site.name}, ${data.site.address}` : data.site.name
    paragraph(`Consegna in cantiere: ${where}`, BODY)
    // Public works: the supplier must quote CIG and CUP on its invoice.
    const codes = [
      data.site.cig ? `CIG ${data.site.cig}` : null,
      data.site.cup ? `CUP ${data.site.cup}` : null,
    ].filter(Boolean)
    if (codes.length) paragraph(`${codes.join(' - ')}, da riportare in fattura`, BODY)
  }
  if (data.delivery_date)
    paragraph(`Consegna richiesta entro il ${italianDate(data.delivery_date)}`, BODY)
  y -= 6

  tableHeader()
  for (const line of data.lines) {
    const rows = wrap(line.description, DESCRIPTION_WIDTH, BODY)
    if (y - rows.length * LEADING < BOTTOM) {
      newPage()
      tableHeader()
    }
    const top = y
    for (const row of rows) {
      pdf.text(MARGIN, y, row, BODY)
      y -= LEADING
    }
    pdf.textRight(COLUMNS.unit, top, line.unit ?? '', BODY)
    pdf.textRight(COLUMNS.quantity, top, italianQuantity(line.quantity), BODY)
    pdf.textRight(COLUMNS.price, top, italianAmount(line.unit_price), BODY)
    pdf.textRight(RIGHT, top, italianAmount(line.amount), BODY)
  }

  if (y - (2 * LEADING + 20) < BOTTOM) newPage()
  pdf.line(MARGIN, y + 4, RIGHT, y + 4)
  y -= 8
  pdf.textRight(RIGHT - 90, y, 'Totale (IVA esclusa)', { size: 11, bold: true })
  pdf.textRight(RIGHT, y, `€ ${italianAmount(data.total)}`, { size: 11, bold: true })
  y -= 2 * LEADING
  if (data.notes) {
    paragraph('Note', BOLD)
    paragraph(data.notes, BODY)
  }

  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `Ordine n. ${data.number} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
