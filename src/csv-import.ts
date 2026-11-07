import type { FieldErrors } from './http/errors.js'

/**
 * Reading of CSV files saved by a spreadsheet, for the imports: UTF-8 (with or without BOM),
 * separator ; tab or , found from the first line, RFC 4180 quoting.
 */

/** Header names compare lowercased, without accents and without anything but letters and digits. */
export const normalizeHeader = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
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

export interface CsvRecord {
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

export class ImportFailed extends Error {
  constructor(readonly errors: FieldErrors) {
    super('Il file non è valido.')
  }
}

export interface CsvRows {
  header: string[]
  /** Data records with the file line where each starts; blank records are left out. */
  rows: CsvRecord[]
}

/** Decodes the file and splits it in records; throws ImportFailed for encoding and empty files. */
export function readCsv(body: Buffer): CsvRows {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
  } catch {
    throw new ImportFailed({
      file: ['Il file non è in UTF-8: salvalo come «CSV UTF-8» dal foglio di calcolo.'],
    })
  }
  if (text.trim() === '') throw new ImportFailed({ file: ['Il file è vuoto.'] })
  const iterator = records(text, detectSeparator(text))
  const header = (iterator.next().value as CsvRecord).fields
  const rows: CsvRecord[] = []
  for (const record of iterator) {
    // Our exports put an apostrophe before a cell that looks like a formula: drop it.
    record.fields = record.fields.map((f) => (/^'[=+\-@]/.test(f) ? f.slice(1) : f))
    if (record.fields.some((f) => f.trim() !== '')) rows.push(record)
  }
  return { header, rows }
}

const YES = new Set(['si', 'sì', 'yes', 'true', 'x', '1'])
const NO = new Set(['no', 'false', '0'])

/** Sì/No of a CSV cell (also yes, true, x, 1 and no, false, 0); `empty` when blank; else null. */
export function readYesNo(value: string, empty: boolean): boolean | null {
  const text = value.trim().toLowerCase()
  if (text === '') return empty
  if (YES.has(text)) return true
  if (NO.has(text)) return false
  return null
}
