import { amountToCents } from '../money.js'
import type { FieldErrors } from '../http/errors.js'

/** Largest CSV file accepted by the import: a regional price list fits comfortably. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
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

const normalizeHeader = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** The separator is the most frequent of ; tab , in the first line (ties go in that order). */
function detectSeparator(text: string): string {
  const end = text.search(/\r?\n/)
  const first = end === -1 ? text : text.slice(0, end)
  let best = ';'
  let bestCount = -1
  for (const candidate of [';', '\t', ',']) {
    const count = first.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

interface CsvRecord {
  line: number
  fields: string[]
}

/** RFC 4180 records: quoted fields may hold separators, doubled quotes and line breaks. */
function* records(text: string, separator: string): Generator<CsvRecord> {
  let line = 1
  let i = 0
  while (i < text.length) {
    const start = line
    const fields: string[] = []
    let field = ''
    let quoted = false
    let ended = false
    while (i < text.length) {
      const c = text[i] as string
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          quoted = false
        } else {
          if (c === '\n') line++
          field += c
        }
        i++
      } else if (c === '"' && field.trim() === '') {
        quoted = true
        field = ''
        i++
      } else if (c === separator) {
        fields.push(field)
        field = ''
        i++
      } else if (c === '\r' || c === '\n') {
        i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
        line++
        ended = true
        break
      } else {
        field += c
        i++
      }
    }
    fields.push(field)
    yield { line: start, fields }
    if (!ended) break
  }
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

export class ImportFailed extends Error {
  constructor(readonly errors: FieldErrors) {
    super('Il file non è valido.')
  }
}

/** Reads the CSV file of a price list; throws ImportFailed listing what is wrong. */
export function parsePriceListCsv(body: Buffer): ImportedItem[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
  } catch {
    throw new ImportFailed({
      file: ['Il file non è in UTF-8: salvalo come «CSV UTF-8» dal foglio di calcolo.'],
    })
  }
  if (text.trim() === '') throw new ImportFailed({ file: ['Il file è vuoto.'] })

  const separator = detectSeparator(text)
  const iterator = records(text, separator)
  const header = iterator.next().value as CsvRecord
  const positions = new Map<Column, number>()
  header.fields.forEach((name, index) => {
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

  for (const record of iterator) {
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
