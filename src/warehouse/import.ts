import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import type { FieldErrors } from '../http/errors.js'

/** Most items in one file. */
export const MAX_ITEM_IMPORT_ROWS = 5000

const FIELDS = ['code', 'name', 'unit', 'stock', 'notes'] as const
type Field = (typeof FIELDS)[number]

/** Header names (normalized, see normalizeHeader) of each field, Italian first. */
const HEADERS: Record<string, Field> = {
  codice: 'code',
  cod: 'code',
  code: 'code',
  articolo: 'name',
  nome: 'name',
  descrizione: 'name',
  name: 'name',
  unita: 'unit',
  unitadimisura: 'unit',
  um: 'unit',
  unit: 'unit',
  giacenza: 'stock',
  quantita: 'stock',
  stock: 'stock',
  note: 'notes',
  notes: 'notes',
}

const FIELD_NAMES: Record<Field, string> = {
  code: 'codice',
  name: 'articolo',
  unit: 'unità',
  stock: 'giacenza',
  notes: 'note',
}

const QUANTITY = /^\d{1,11}(?:\.\d{1,3})?$/

/** "unità: message" for each field error of the item checks. */
export function itemRowMessages(errors: FieldErrors): string[] {
  return Object.entries(errors).flatMap(([field, list]) =>
    list.map((m) => `${FIELD_NAMES[field as Field] ?? field}: ${m}`),
  )
}

/**
 * 12,500 or 1.234,5 (Italian) or 12.5; at most three decimals, never negative. The text of a
 * numeric for the database, or null.
 */
export function parseQuantity(value: string): string | null {
  const text = value.replace(/\s/g, '')
  let plain: string
  if (text.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(text)) return null
    plain = text.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(text)) plain = text.replace(/\./g, '')
  else plain = text
  return QUANTITY.test(plain) ? plain : null
}

export interface ImportedItem<T> {
  line: number
  input: T
  /** Stock to load as a first "in" movement, or null when blank or zero. */
  stock: string | null
}

/**
 * Reads a CSV file of warehouse items (as exportWarehouseItems writes it), each row checked by
 * `parse` as a new item would be. Duplicate codes against the database are found when inserting.
 */
export function parseWarehouseItemsCsv<T>(
  body: Buffer,
  parse: (body: unknown) => { input: T } | { errors: FieldErrors },
): ImportedItem<T>[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  const missing = (['name', 'unit'] as const).filter((f) => !positions.has(f))
  if (missing.length > 0) {
    throw new ImportFailed({
      file: [
        `Nella prima riga manca la colonna ${missing.map((f) => FIELD_NAMES[f]).join(' e ')}.`,
      ],
    })
  }
  if (rows.length === 0) throw new ImportFailed({ file: ['Il file non ha articoli.'] })
  if (rows.length > MAX_ITEM_IMPORT_ROWS) {
    throw new ImportFailed({ file: [`Al massimo ${MAX_ITEM_IMPORT_ROWS} articoli per file.`] })
  }

  const errors = new RowErrors()
  const items: ImportedItem<T>[] = []
  for (const record of rows) {
    const cell = (field: Field) => {
      const index = positions.get(field)
      return index === undefined ? '' : (record.fields[index] ?? '').trim()
    }
    const input: Record<string, unknown> = {}
    for (const field of FIELDS) if (field !== 'stock') input[field] = cell(field)

    let stock: string | null = null
    const stockText = cell('stock')
    if (stockText !== '') {
      stock = parseQuantity(stockText)
      if (stock === null) {
        errors.add(record.line, [
          'giacenza: una quantità non negativa, al massimo tre decimali (es. 12,500).',
        ])
        continue
      }
      if (/^[0.]+$/.test(stock)) stock = null
    }
    const parsed = parse(input)
    if ('errors' in parsed) errors.add(record.line, itemRowMessages(parsed.errors))
    else items.push({ line: record.line, input: parsed.input, stock })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  return items
}
