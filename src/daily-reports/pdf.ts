import type { PdfImage } from '../pdf/image.js'
import { A4, PdfDocument, textWidth, wrap, type TextStyle } from '../pdf/pdf.js'
import { companyHeader, italianQuantity, type QuotePdfData } from '../quotes/pdf.js'

export interface ReportPdfData {
  logo?: PdfImage | undefined
  company: QuotePdfData['company']
  site: { name: string; code: string | null; address: string | null }
  date: string
  status: 'draft' | 'submitted' | 'approved'
  weather: string | null
  work_done: string | null
  notes: string | null
  created_by: string | null
  approved_by: string | null
  approved_at: Date | null
  total_labor_hours: string
  total_vehicle_hours: string
  labor: { first_name: string; last_name: string; hours: string; description: string | null }[]
  vehicles: { name: string; plate: string | null; hours: string; description: string | null }[]
}

const MARGIN = 42
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const BODY: TextStyle = { size: 9 }
const BOLD: TextStyle = { size: 9, bold: true }
const LEADING = 12

// The name column, then the activity; the hours sit on the right edge.
const ACTIVITY_X = 230
const NAME_WIDTH = ACTIVITY_X - MARGIN - 10
const ACTIVITY_WIDTH = RIGHT - 60 - ACTIVITY_X

const italianDate = (date: string) => date.split('-').reverse().join('/')
const romeDate = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** The daily report in A4, to file or have signed: hours of people and machines, no costs. */
export function reportPdf(data: ReportPdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const paragraph = (text: string, style: TextStyle) => {
    for (const line of wrap(text, RIGHT - MARGIN, style)) {
      if (y - LEADING < BOTTOM) newPage()
      pdf.text(MARGIN, y, line, style)
      y -= LEADING
    }
  }
  const table = (
    title: string,
    rows: { name: string; activity: string | null; hours: string }[],
    total: string,
  ) => {
    if (y - 3 * LEADING < BOTTOM) newPage()
    const header = () => {
      const row = y - 10
      pdf.text(MARGIN, row, title, BOLD)
      pdf.text(ACTIVITY_X, row, 'Attività', BOLD)
      pdf.textRight(RIGHT, row, 'Ore', BOLD)
      pdf.line(MARGIN, row - 4, RIGHT, row - 4)
      y = row - 4 - LEADING
    }
    header()
    if (rows.length === 0) {
      pdf.text(MARGIN, y, 'Nessuno', BODY)
      y -= LEADING
    }
    for (const r of rows) {
      const names = wrap(r.name, NAME_WIDTH, BODY)
      const activity = r.activity ? wrap(r.activity, ACTIVITY_WIDTH, BODY) : []
      const height = Math.max(names.length, activity.length, 1) * LEADING
      if (y - height < BOTTOM) {
        newPage()
        header()
      }
      const top = y
      names.forEach((line, i) => pdf.text(MARGIN, top - i * LEADING, line, BODY))
      activity.forEach((line, i) => pdf.text(ACTIVITY_X, top - i * LEADING, line, BODY))
      pdf.textRight(RIGHT, top, italianQuantity(r.hours), BODY)
      y = top - height
    }
    pdf.line(MARGIN, y + 4, RIGHT, y + 4)
    y -= 6
    pdf.textRight(RIGHT - 50, y, 'Totale ore', BOLD)
    pdf.textRight(RIGHT, y, italianQuantity(total), BOLD)
    y -= 2 * LEADING
  }

  newPage()
  const header = companyHeader(pdf, data.logo, data.company, y)
  y = header.bottom - 12
  const day = italianDate(data.date)
  const title =
    data.status === 'draft'
      ? `Rapportino del ${day} (bozza, non ancora inviato)`
      : `Rapportino del ${day}`
  pdf.text(MARGIN, y, title, { size: 12, bold: true })
  y -= LEADING + 4

  const site = data.site.code ? `${data.site.code} – ${data.site.name}` : data.site.name
  paragraph(`Cantiere: ${site}`, BOLD)
  if (data.site.address) paragraph(data.site.address, BODY)
  if (data.weather) paragraph(`Meteo: ${data.weather}`, BODY)
  if (data.created_by) paragraph(`Compilato da: ${data.created_by}`, BODY)
  if (data.status === 'approved' && data.approved_at) {
    const by = data.approved_by ? ` da ${data.approved_by}` : ''
    paragraph(`Approvato${by} il ${romeDate.format(data.approved_at)}`, BODY)
  }
  y -= 6
  if (data.work_done) {
    paragraph('Lavori eseguiti', BOLD)
    paragraph(data.work_done, BODY)
    y -= 6
  }

  table(
    'Dipendenti',
    data.labor.map((l) => ({
      name: `${l.last_name} ${l.first_name}`,
      activity: l.description,
      hours: l.hours,
    })),
    data.total_labor_hours,
  )
  table(
    'Mezzi',
    data.vehicles.map((v) => ({
      name: v.plate ? `${v.name} (${v.plate})` : v.name,
      activity: v.description,
      hours: v.hours,
    })),
    data.total_vehicle_hours,
  )

  if (data.notes) {
    paragraph('Note', BOLD)
    paragraph(data.notes, BODY)
  }

  y -= 24
  if (y - 3 * LEADING < BOTTOM) newPage()
  pdf.text(MARGIN, y, 'Il capo cantiere', BODY)
  pdf.text(RIGHT - 220, y, 'Per il committente o la direzione lavori', BODY)
  pdf.line(MARGIN, y - 28, MARGIN + 200, y - 28)
  pdf.line(RIGHT - 220, y - 28, RIGHT, y - 28)

  for (let page = 0; page < pdf.pageCount; page++) {
    const text = `Rapportino del ${day} – pagina ${page + 1} di ${pdf.pageCount}`
    pdf.text(RIGHT - textWidth(text, { size: 8 }), 30, text, { size: 8 }, page)
  }
  return pdf.toBuffer()
}
