import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import type { FieldErrors } from '../http/errors.js'
import {
  SUPPLIER_FIELDS,
  parseSupplierInput,
  type SupplierCategory,
  type SupplierInput,
} from './input.js'

/** Most suppliers in one file. */
export const MAX_SUPPLIER_IMPORT_ROWS = 5000

type Field = (typeof SUPPLIER_FIELDS)[number]

/** Header names (normalized, see normalizeHeader) of each field, Italian first. */
const HEADERS: Record<string, Field> = {
  nome: 'name',
  ragionesociale: 'name',
  denominazione: 'name',
  name: 'name',
  partitaiva: 'vat_number',
  piva: 'vat_number',
  vatnumber: 'vat_number',
  codicefiscale: 'tax_code',
  cf: 'tax_code',
  taxcode: 'tax_code',
  email: 'email',
  pec: 'pec',
  telefono: 'phone',
  tel: 'phone',
  phone: 'phone',
  indirizzo: 'street',
  via: 'street',
  street: 'street',
  cap: 'postal_code',
  postalcode: 'postal_code',
  citta: 'city',
  comune: 'city',
  city: 'city',
  provincia: 'province',
  prov: 'province',
  province: 'province',
  paese: 'country',
  nazione: 'country',
  country: 'country',
  categorie: 'categories',
  categoria: 'categories',
  categories: 'categories',
  subappaltatore: 'subcontractor',
  subappalto: 'subcontractor',
  subcontractor: 'subcontractor',
  note: 'notes',
  notes: 'notes',
}

const FIELD_NAMES: Record<Field, string> = {
  name: 'nome',
  vat_number: 'partita IVA',
  tax_code: 'codice fiscale',
  email: 'email',
  pec: 'PEC',
  phone: 'telefono',
  street: 'indirizzo',
  postal_code: 'CAP',
  city: 'città',
  province: 'provincia',
  country: 'paese',
  categories: 'categorie',
  subcontractor: 'subappaltatore',
  notes: 'note',
}

const CATEGORIES: Record<string, SupplierCategory> = {
  materiali: 'materials',
  materials: 'materials',
  noli: 'rentals',
  nolo: 'rentals',
  rentals: 'rentals',
  subappalto: 'subcontracting',
  subappalti: 'subcontracting',
  subcontracting: 'subcontracting',
  servizi: 'services',
  servizio: 'services',
  services: 'services',
  altro: 'other',
  other: 'other',
}

const YES = new Set(['si', 'sì', 'yes', 'true', 'x', '1'])
const NO = new Set(['', 'no', 'false', '0'])

export interface ImportedSupplier {
  line: number
  input: SupplierInput
}

/** "partita IVA: message" for each field error of parseSupplierInput. */
export function supplierRowMessages(errors: FieldErrors): string[] {
  return Object.entries(errors).flatMap(([field, list]) =>
    list.map((m) => `${FIELD_NAMES[field as Field] ?? field}: ${m}`),
  )
}

/**
 * Reads a CSV file of suppliers, each checked as a new supplier would be. Categories are
 * separated by commas (as exportSuppliers writes them); duplicates against the database are
 * found when inserting.
 */
export function parseSuppliersCsv(body: Buffer): ImportedSupplier[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  if (!positions.has('name')) {
    throw new ImportFailed({ file: ['Nella prima riga manca la colonna nome.'] })
  }
  if (rows.length === 0) throw new ImportFailed({ file: ['Il file non ha fornitori.'] })
  if (rows.length > MAX_SUPPLIER_IMPORT_ROWS) {
    throw new ImportFailed({
      file: [`Al massimo ${MAX_SUPPLIER_IMPORT_ROWS} fornitori per file.`],
    })
  }

  const errors = new RowErrors()
  const suppliers: ImportedSupplier[] = []
  for (const record of rows) {
    const cell = (field: Field) => {
      const index = positions.get(field)
      return index === undefined ? '' : (record.fields[index] ?? '').trim()
    }
    const body: Record<string, unknown> = {}
    for (const field of SUPPLIER_FIELDS) body[field] = cell(field)
    const problems: string[] = []

    const categories: SupplierCategory[] = []
    for (const part of cell('categories').split(/[,|/]/)) {
      const name = normalizeHeader(part)
      if (name === '') continue
      const category = CATEGORIES[name]
      if (category) categories.push(category)
      else problems.push(`categorie: «${part.trim()}» non è una categoria.`)
    }
    body.categories = categories
    const flag = cell('subcontractor').toLowerCase()
    if (YES.has(flag)) body.subcontractor = true
    else if (NO.has(flag)) body.subcontractor = false
    else problems.push('subappaltatore: sì oppure no.')
    if (body.country === '') body.country = 'IT'

    if (problems.length > 0) {
      errors.add(record.line, problems)
      continue
    }
    const parsed = parseSupplierInput(body)
    if ('errors' in parsed) errors.add(record.line, supplierRowMessages(parsed.errors))
    else suppliers.push({ line: record.line, input: parsed.input })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  return suppliers
}
