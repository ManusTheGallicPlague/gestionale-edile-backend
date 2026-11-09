import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { MAX_ITEM_IMPORT_ROWS, parseQuantity } from './import.js'

type Field = 'code' | 'name' | 'counted'

/** Header names (normalized, see normalizeHeader) of each column, Italian first. */
const HEADERS: Record<string, Field> = {
  codice: 'code',
  cod: 'code',
  code: 'code',
  articolo: 'name',
  nome: 'name',
  descrizione: 'name',
  name: 'name',
  contata: 'counted',
  conta: 'counted',
  quantitacontata: 'counted',
  inventario: 'counted',
  counted: 'counted',
}

export interface CountedRow {
  line: number
  code: string
  name: string
  quantity: string
}

/**
 * Reads a filled-in count sheet: usually magazzino.csv with a «Contata» column added. Rows with
 * the counted cell blank are left out (not counted); the others need a valid quantity.
 */
export function parseStockCountCsv(body: Buffer): CountedRow[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  if (!positions.has('counted')) {
    throw new ImportFailed({ file: ['Nella prima riga manca la colonna contata.'] })
  }
  if (!positions.has('code') && !positions.has('name')) {
    throw new ImportFailed({ file: ['Nella prima riga manca la colonna codice o articolo.'] })
  }
  if (rows.length > MAX_ITEM_IMPORT_ROWS) {
    throw new ImportFailed({ file: [`Al massimo ${MAX_ITEM_IMPORT_ROWS} articoli per file.`] })
  }
  const errors = new RowErrors()
  const counted: CountedRow[] = []
  for (const record of rows) {
    const cell = (field: Field) => {
      const index = positions.get(field)
      return index === undefined ? '' : (record.fields[index] ?? '').trim()
    }
    const text = cell('counted')
    if (text === '') continue
    const quantity = parseQuantity(text)
    const code = cell('code')
    const name = cell('name')
    const messages: string[] = []
    if (quantity === null) {
      messages.push('contata: una quantità non negativa, al massimo tre decimali (es. 12,500).')
    }
    if (code === '' && name === '') messages.push('articolo: indica il codice o il nome.')
    if (messages.length > 0 || quantity === null) errors.add(record.line, messages)
    else counted.push({ line: record.line, code, name, quantity })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  if (counted.length === 0) {
    throw new ImportFailed({ file: ['Il file non ha quantità contate nella colonna contata.'] })
  }
  return counted
}
