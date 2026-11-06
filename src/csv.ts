/**
 * CSV for spreadsheets opened in Italian locale: semicolon separator, CRLF, UTF-8 with BOM
 * (so accented letters show right). Cells that a spreadsheet would run as a formula are
 * prefixed with an apostrophe (CSV injection).
 */
export type Cell = string | number | null | undefined

const FORMULA_START = /^[=+\-@\t\r]/

function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const BOM = String.fromCharCode(0xfeff)

export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((row) => row.map(cell).join(';'))
  return `${BOM}${lines.join('\r\n')}\r\n`
}

/** Most rows an export returns: beyond this the user narrows the filters. */
export const MAX_EXPORT_ROWS = 10000
