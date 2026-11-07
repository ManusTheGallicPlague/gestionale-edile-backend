import { amountToCents } from '../money.js'
import type { FieldErrors } from '../http/errors.js'
import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'

/** Most data rows in one file. */
export const MAX_IMPORT_ROWS = 20000
/** Most row errors reported: beyond this the user fixes the file and tries again. */
const MAX_ROW_ERRORS = 50

export interface ImportedItem {
  code: string
  description: string
  unit: string
  unit_price_cents: string
}

type Column = keyof ImportedItem

/** Header names, lowercased, without accents and without anything but letters and digits. */
const HEADERS: Record<string, Column> = {
  codice: 'code',
  code: 'code',
  cod: 'code',
  descrizione: 'description',
  description: 'description',
  unita: 'unit',
  unitadimisura: 'unit',
  um: 'unit',
  unit: 'unit',
  prezzo: 'unit_price_cents',
  prezzounitario: 'unit_price_cents',
  unitprice: 'unit_price_cents',
}

const COLUMN_NAMES: Record<Column, string> = {
  code: 'codice',
  description: 'descrizione',
  unit: 'unità',
  unit_price_cents: 'prezzo',
}

const LIMITS: Record<Exclude<Column, 'unit_price_cents'>, number> = {
  code: 50,
  description: 2000,
  unit: 20,
}

/** 1.234,50 or 1234,5 (Italian) or 1234.50; an optional € sign; never negative. */
export function parsePrice(value: string): string | null {
  const text = value.replace(/€/g, '').replace(/\s/g, '')
  let plain: string
  if (/^\d{1,3}(\.\d{3})+,\d+$|^\d+,\d+$/.test(text)) {
    plain = text.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(text)) {
    // 1.234.567: only thousands separators. One dot (1.234) is a decimal point.
    plain = text.replace(/\./g, '')
  } else plain = text
  return amountToCents(plain)
}

export { ImportFailed }

/** Reads the CSV file of a price list; throws ImportFailed listing what is wrong. */
export function parsePriceListCsv(body: Buffer): ImportedItem[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Column, number>()
  header.forEach((name, index) => {
    const column = HEADERS[normalizeHeader(name)]
    if (column && !positions.has(column)) positions.set(column, index)
  })
  const missing = (Object.keys(COLUMN_NAMES) as Column[]).filter((c) => !positions.has(c))
  if (missing.length > 0) {
    throw new ImportFailed({
      file: [
        `Nella prima riga mancano le colonne: ${missing.map((c) => COLUMN_NAMES[c]).join(', ')}.`,
      ],
    })
  }

  const items: ImportedItem[] = []
  const errors: FieldErrors = {}
  const seen = new Map<string, number>()
  let errorCount = 0
  const fail = (line: number, message: string) => {
    if (errorCount >= MAX_ROW_ERRORS) return
    const key = `row.${line}`
    if (!errors[key]) {
      errors[key] = []
      errorCount++
    }
    errors[key].push(message)
  }

  for (const record of rows) {
    if (record.fields.every((f) => f.trim() === '')) continue
    if (items.length >= MAX_IMPORT_ROWS) {
      throw new ImportFailed({ file: [`Al massimo ${MAX_IMPORT_ROWS} righe per file.`] })
    }
    const get = (column: Column) => (record.fields[positions.get(column) as number] ?? '').trim()
    const values = { code: get('code'), description: get('description'), unit: get('unit') }
    let valid = true
    for (const column of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const value = values[column]
      if (value === '') {
        fail(record.line, `Manca ${COLUMN_NAMES[column]}.`)
        valid = false
      } else if (value.length > LIMITS[column]) {
        fail(record.line, `${COLUMN_NAMES[column]}: al massimo ${LIMITS[column]} caratteri.`)
        valid = false
      }
    }
    const price = parsePrice(get('unit_price_cents'))
    if (price === null) {
      fail(record.line, 'Prezzo non valido (es. 1.234,50).')
      valid = false
    }
    if (values.code !== '') {
      const key = values.code.toLowerCase()
      const previous = seen.get(key)
      if (previous !== undefined) {
        fail(record.line, `Il codice è già alla riga ${previous}.`)
        valid = false
      } else seen.set(key, record.line)
    }
    if (valid && price !== null) items.push({ ...values, unit_price_cents: price })
  }
  if (errorCount > 0) throw new ImportFailed(errors)
  if (items.length === 0) throw new ImportFailed({ file: ['Il file non ha voci.'] })
  return items
}
