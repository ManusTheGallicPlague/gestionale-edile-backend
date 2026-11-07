import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { parsePrice } from '../price-lists/import.js'
import { centsToAmount } from '../money.js'
import type { FieldErrors } from '../http/errors.js'

/** Most employees in one file. */
export const MAX_EMPLOYEE_IMPORT_ROWS = 5000

const FIELDS = [
  'last_name',
  'first_name',
  'tax_code',
  'job_title',
  'phone',
  'email',
  'hired_on',
  'hourly_cost',
  'active',
  'notes',
] as const
type Field = (typeof FIELDS)[number]

/** Header names (normalized, see normalizeHeader) of each field, Italian first. */
const HEADERS: Record<string, Field> = {
  cognome: 'last_name',
  lastname: 'last_name',
  nome: 'first_name',
  firstname: 'first_name',
  codicefiscale: 'tax_code',
  cf: 'tax_code',
  taxcode: 'tax_code',
  mansione: 'job_title',
  qualifica: 'job_title',
  jobtitle: 'job_title',
  telefono: 'phone',
  tel: 'phone',
  cellulare: 'phone',
  phone: 'phone',
  email: 'email',
  assunzione: 'hired_on',
  dataassunzione: 'hired_on',
  dataassunto: 'hired_on',
  hiredon: 'hired_on',
  costoorario: 'hourly_cost',
  costo: 'hourly_cost',
  hourlycost: 'hourly_cost',
  attivo: 'active',
  active: 'active',
  note: 'notes',
  notes: 'notes',
}

const FIELD_NAMES: Record<Field, string> = {
  last_name: 'cognome',
  first_name: 'nome',
  tax_code: 'codice fiscale',
  job_title: 'mansione',
  phone: 'telefono',
  email: 'email',
  hired_on: 'assunzione',
  hourly_cost: 'costo orario',
  active: 'attivo',
  notes: 'note',
}

const YES = new Set(['', 'si', 'sì', 'yes', 'true', 'x', '1'])
const NO = new Set(['no', 'false', '0'])

/** "codice fiscale: message" for each field error of parseEmployeeInput. */
export function employeeRowMessages(errors: FieldErrors): string[] {
  return Object.entries(errors).flatMap(([field, list]) =>
    list.map((m) => `${FIELD_NAMES[field as Field] ?? field}: ${m}`),
  )
}

/** 30/11/2026 (as exportEmployees writes it, also with - or .) or 2026-11-30; else null. */
export function parseImportDate(value: string): string | null {
  const italian = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value)
  if (italian) {
    const [, day, month, year] = italian as unknown as [string, string, string, string]
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export interface ImportedRow<T> {
  line: number
  input: T
}

/**
 * Reads a CSV file of employees, each row checked by `parse` (parseEmployeeInput) as a new
 * employee would be. Duplicate tax codes against the database are found when inserting.
 */
export function parseEmployeesCsv<T>(
  body: Buffer,
  parse: (body: unknown) => { input: T } | { errors: FieldErrors },
): ImportedRow<T>[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  const missing = (['last_name', 'first_name'] as const).filter((f) => !positions.has(f))
  if (missing.length > 0) {
    throw new ImportFailed({
      file: [
        `Nella prima riga manca la colonna ${missing.map((f) => FIELD_NAMES[f]).join(' e ')}.`,
      ],
    })
  }
  if (rows.length === 0) throw new ImportFailed({ file: ['Il file non ha dipendenti.'] })
  if (rows.length > MAX_EMPLOYEE_IMPORT_ROWS) {
    throw new ImportFailed({
      file: [`Al massimo ${MAX_EMPLOYEE_IMPORT_ROWS} dipendenti per file.`],
    })
  }

  const errors = new RowErrors()
  const employees: ImportedRow<T>[] = []
  for (const record of rows) {
    const cell = (field: Field) => {
      const index = positions.get(field)
      return index === undefined ? '' : (record.fields[index] ?? '').trim()
    }
    const input: Record<string, unknown> = {}
    for (const field of FIELDS) input[field] = cell(field)
    const problems: string[] = []

    const hired = cell('hired_on')
    if (hired !== '') {
      const date = parseImportDate(hired)
      if (date === null) problems.push('assunzione: data non valida (es. 30/11/2026).')
      else input.hired_on = date
    }
    const cost = cell('hourly_cost')
    if (cost !== '') {
      const cents = parsePrice(cost)
      if (cents === null) problems.push('costo orario: importo non valido (es. 28,50).')
      else input.hourly_cost = centsToAmount(cents)
    }
    const flag = cell('active').toLowerCase()
    if (YES.has(flag)) input.active = true
    else if (NO.has(flag)) input.active = false
    else problems.push('attivo: sì oppure no.')

    if (problems.length > 0) {
      errors.add(record.line, problems)
      continue
    }
    const parsed = parse(input)
    if ('errors' in parsed) errors.add(record.line, employeeRowMessages(parsed.errors))
    else employees.push({ line: record.line, input: parsed.input })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  return employees
}
