import { A4, PdfDocument, wrap, type TextStyle } from '../pdf/pdf.js'

export interface SitePartyPdf {
  name: string
  street: string | null
  postal_code: string | null
  city: string | null
  province: string | null
  vat_number: string | null
  tax_code: string | null
}

export interface SiteSignPdfData {
  site: {
    name: string
    address: string | null
    client: string | null
    permit: string | null
    cig: string | null
    cup: string | null
    works_director: string | null
    safety_coordinator: string | null
    prior_notice_on: string | null
    start_on: string | null
    end_on: string | null
  }
  company: SitePartyPdf
  /** Null when the user cannot see suppliers: the section is left out. */
  subcontractors: { name: string; vat_number: string | null }[] | null
}

const MARGIN = 48
const RIGHT = A4.width - MARGIN
const BOTTOM = 60
const LABEL: TextStyle = { size: 9, bold: true }
const VALUE: TextStyle = { size: 14 }
const VALUE_LEADING = 18
const BLANK = '_______________________________________________'

const italianDate = (date: string) => date.split('-').reverse().join('/')

/** Address and VAT number of a party, in one line. */
function partyDetails(p: SitePartyPdf): string {
  const place = [p.postal_code, p.city, p.province ? `(${p.province})` : null]
    .filter(Boolean)
    .join(' ')
  const tax = p.vat_number ? `P. IVA ${p.vat_number}` : p.tax_code ? `C.F. ${p.tax_code}` : null
  return [p.street, place, tax].filter(Boolean).join(' – ')
}

/**
 * The site sign in A4 portrait, to enlarge and hang at the entrance: each entry has a small
 * label and the value under it; an entry that is not set gets a blank line to fill in by hand.
 */
export function siteSignPdf(data: SiteSignPdfData): Buffer {
  const pdf = new PdfDocument()
  let y = 0
  const newPage = () => {
    pdf.addPage()
    y = A4.height - MARGIN
  }
  const lines = (text: string, style: TextStyle, leading: number) => {
    for (const line of wrap(text, RIGHT - MARGIN, style)) {
      if (y - leading < BOTTOM) newPage()
      pdf.text(MARGIN, y, line, style)
      y -= leading
    }
  }
  const entry = (label: string, value: string | null, extra?: string) => {
    if (y - (16 + VALUE_LEADING) < BOTTOM) newPage()
    lines(label.toUpperCase(), LABEL, 16)
    lines(value ?? BLANK, VALUE, VALUE_LEADING)
    if (extra) lines(extra, { size: 10 }, 13)
    y -= 10
  }
  const date = (value: string | null) => value && italianDate(value)

  newPage()
  const title: TextStyle = { size: 24, bold: true }
  pdf.text(MARGIN, y - 24, 'CARTELLO DI CANTIERE', title)
  y -= 36
  pdf.line(MARGIN, y, RIGHT, y, 1.5)
  y -= 24

  const s = data.site
  entry('Lavori', s.name)
  entry('Ubicazione', s.address)
  entry('Committente', s.client)
  entry('Titolo edilizio', s.permit)
  const codes = [s.cig ? `CIG ${s.cig}` : null, s.cup ? `CUP ${s.cup}` : null].filter(Boolean)
  if (codes.length) entry('Codici dei lavori pubblici', codes.join(' – '))
  entry('Impresa esecutrice', data.company.name, partyDetails(data.company) || undefined)
  entry('Direttore dei lavori', s.works_director)
  entry('Coordinatore per la sicurezza in fase di esecuzione', s.safety_coordinator)
  entry('Notifica preliminare del', date(s.prior_notice_on))
  entry('Inizio dei lavori', date(s.start_on))
  entry('Fine prevista dei lavori', date(s.end_on))
  if (data.subcontractors && data.subcontractors.length) {
    if (y - 2 * 12 < BOTTOM) newPage()
    lines('IMPRESE SUBAPPALTATRICI', LABEL, 14)
    for (const sub of data.subcontractors) {
      const text = sub.vat_number ? `${sub.name} – P. IVA ${sub.vat_number}` : sub.name
      lines(text, { size: 12 }, 16)
    }
  }
  return pdf.toBuffer()
}
