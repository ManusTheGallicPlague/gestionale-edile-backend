import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { groupTree, type EstimateTree, type TreeChapter, type TreeItem } from './tree.js'
import { companyHeader, italianAmount, italianQuantity, type QuotePdfData } from '../quotes/pdf.js'

export interface EstimatePdfData extends EstimateTree {
  logo?: PdfImage | undefined
  company: QuotePdfData['company']
  estimate: { title: string; client: string | null; site: string | null; address: string | null }
  total: string
  /** False: the bill of quantities with empty price and amount columns, to ask for offers. */
  prices: boolean
}

const MARGIN = 42
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const BODY: TextStyle = { size: 8 }
const BOLD: TextStyle = { size: 8, bold: true }
const LEADING = 11

// Right edges of the columns; the description takes what is left.
const COLUMNS = {
  equal_parts: 300,
  length: 340,
  width: 380,
  height: 420,
  quantity: 465,
  price: 508,
} as const
const NUMBER_WIDTH = 22
const DESCRIPTION_WIDTH = 270 - MARGIN - NUMBER_WIDTH

/**
 * The bill of quantities in A4: chapters in the order of the tree (items first, then
 * sub-chapters), each item with its measurement rows, quantity, price and amount; the
 * total of each chapter, of the estimate and a summary by chapter.
 */
export function estimatePdf(data: EstimatePdfData): Buffer {
  const title = data.prices ? 'Computo metrico estimativo' : 'Computo metrico'
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const tableHeader = () => {
    const row = y - 10
    pdf.text(MARGIN, row, 'N.', BOLD)
    pdf.text(MARGIN + NUMBER_WIDTH, row, 'Voce', BOLD)
    pdf.textRight(COLUMNS.equal_parts, row, 'Par. ug.', BOLD)
    pdf.textRight(COLUMNS.length, row, 'Lung.', BOLD)
    pdf.textRight(COLUMNS.width, row, 'Larg.', BOLD)
    pdf.textRight(COLUMNS.height, row, 'H/peso', BOLD)
    pdf.textRight(COLUMNS.quantity, row, 'Quantità', BOLD)
    pdf.textRight(COLUMNS.price, row, 'Prezzo', BOLD)
    pdf.textRight(RIGHT, row, 'Importo', BOLD)
    pdf.line(MARGIN, row - 4, RIGHT, row - 4)
    y = row - 4 - LEADING
  }
  /** Room for `lines` more lines, or a new page with the table header. */
  const room = (lines: number) => {
    if (y - lines * LEADING < BOTTOM) {
      newPage()
      tableHeader()
    }
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
  pdf.text(MARGIN, y, title, { size: 12, bold: true })
  y -= LEADING + 4
  const e = data.estimate
  paragraph(e.title, { size: 9, bold: true })
  for (const [label, value] of [
    ['Committente', e.client],
    ['Cantiere', e.site],
    ['Luogo dei lavori', e.address],
  ] as const) {
    if (value) paragraph(`${label}: ${value}`, { size: 9 })
  }
  y -= 6
  tableHeader()

  const { children, itemsOf, measurementsOf } = groupTree(data)

  const chapterName = (c: TreeChapter) => (c.code ? `${c.code} ${c.title}` : c.title)
  let number = 0
  const descriptionX = MARGIN + NUMBER_WIDTH

  const item = (it: TreeItem) => {
    number += 1
    const text = it.code ? `${it.code} ${it.description}` : it.description
    const rows = wrap(text, DESCRIPTION_WIDTH + (COLUMNS.height - 270), BODY)
    room(rows.length + 1)
    pdf.text(MARGIN, y, String(number), BODY)
    for (const row of rows) {
      room(1)
      pdf.text(descriptionX, y, row, BODY)
      y -= LEADING
    }
    for (const m of measurementsOf.get(it.id) ?? []) {
      const lines = m.description ? wrap(m.description, DESCRIPTION_WIDTH - 8, BODY) : ['']
      room(lines.length)
      const top = y
      for (const line of lines) {
        pdf.text(descriptionX + 8, y, line, BODY)
        y -= LEADING
      }
      for (const factor of ['equal_parts', 'length', 'width', 'height'] as const) {
        const value = m[factor]
        if (value !== null) pdf.textRight(COLUMNS[factor], top, italianQuantity(value), BODY)
      }
      pdf.textRight(COLUMNS.quantity, top, italianQuantity(m.quantity), BODY)
    }
    room(1)
    pdf.textRight(COLUMNS.height, y, `Sommano ${it.unit}`, BOLD)
    pdf.textRight(COLUMNS.quantity, y, italianQuantity(it.quantity), BOLD)
    if (data.prices) {
      pdf.textRight(COLUMNS.price, y, italianAmount(it.unit_price), BODY)
      pdf.textRight(RIGHT, y, italianAmount(it.amount), BOLD)
    }
    y -= LEADING + 3
  }

  const chapter = (c: TreeChapter, depth: number) => {
    room(3)
    const indent = Math.min(depth, 3) * 8
    for (const line of wrap(chapterName(c), RIGHT - MARGIN - indent, BOLD)) {
      room(1)
      pdf.text(MARGIN + indent, y, line, depth === 0 ? { size: 9, bold: true } : BOLD)
      y -= LEADING
    }
    y -= 2
    for (const it of itemsOf.get(c.id) ?? []) item(it)
    for (const sub of children.get(c.id) ?? []) chapter(sub, depth + 1)
    if (data.prices) {
      room(1)
      pdf.textRight(COLUMNS.price, y, `Totale ${c.title}`.slice(0, 80), BOLD)
      pdf.textRight(RIGHT, y, italianAmount(c.amount), BOLD)
      y -= LEADING
    }
    y -= 6
  }

  for (const c of children.get(null) ?? []) chapter(c, 0)

  if (!data.prices) return finish(pdf, title)
  pdf.line(MARGIN, y + 4, RIGHT, y + 4)
  y -= 8
  room(1)
  pdf.textRight(COLUMNS.price, y, 'Totale computo', { size: 10, bold: true })
  pdf.textRight(RIGHT, y, `€ ${italianAmount(data.total)}`, { size: 10, bold: true })
  y -= LEADING * 2

  // Summary by chapter, on a page of its own when it does not fit.
  const summary: { name: string; amount: string; depth: number }[] = []
  const collect = (parent: string | null, depth: number) => {
    for (const c of children.get(parent) ?? []) {
      summary.push({ name: chapterName(c), amount: c.amount, depth })
      collect(c.id, depth + 1)
    }
  }
  collect(null, 0)
  if (summary.length > 0) {
    if (y - (summary.length + 3) * LEADING < BOTTOM) newPage()
    pdf.text(MARGIN, y, 'Riepilogo per capitoli', { size: 10, bold: true })
    y -= LEADING + 4
    for (const row of summary) {
      if (y - LEADING < BOTTOM) newPage()
      const style = row.depth === 0 ? BOLD : BODY
      const indent = Math.min(row.depth, 3) * 10
      const [first = ''] = wrap(row.name, RIGHT - MARGIN - indent - 90, style)
      pdf.text(MARGIN + indent, y, first, style)
      pdf.textRight(RIGHT, y, italianAmount(row.amount), style)
      y -= LEADING
    }
    pdf.line(MARGIN, y + 4, RIGHT, y + 4)
    y -= 8
    pdf.textRight(RIGHT - 90, y, 'Totale computo', { size: 10, bold: true })
    pdf.textRight(RIGHT, y, `€ ${italianAmount(data.total)}`, { size: 10, bold: true })
  }

  return finish(pdf, title)
}

/** Page numbers, now that the count is known. */
function finish(pdf: PdfDocument, title: string): Buffer {
  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `${title} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
