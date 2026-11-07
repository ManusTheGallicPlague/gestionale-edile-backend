import { ImportFailed, normalizeHeader, readCsv, readYesNo } from '../csv-import.js'
import { RowErrors } from '../clients/import.js'
import { parsePrice } from '../price-lists/import.js'
import { centsToAmount } from '../money.js'
import type { FieldErrors } from '../http/errors.js'
import type { ImportedRow } from '../employees/import.js'

/** Most vehicles in one file. */
export const MAX_VEHICLE_IMPORT_ROWS = 5000

const FIELDS = ['name', 'kind', 'plate', 'model', 'hourly_cost', 'active', 'notes'] as const
type Field = (typeof FIELDS)[number]

/** Header names (normalized, see normalizeHeader) of each field, Italian first. */
const HEADERS: Record<string, Field> = {
  nome: 'name',
  descrizione: 'name',
  name: 'name',
  tipo: 'kind',
  kind: 'kind',
  targa: 'plate',
  matricola: 'plate',
  plate: 'plate',
  marcaemodello: 'model',
  modello: 'model',
  model: 'model',
  costoorario: 'hourly_cost',
  costo: 'hourly_cost',
  hourlycost: 'hourly_cost',
  inuso: 'active',
  attivo: 'active',
  active: 'active',
  note: 'notes',
  notes: 'notes',
}

const FIELD_NAMES: Record<Field, string> = {
  name: 'nome',
  kind: 'tipo',
  plate: 'targa',
  model: 'marca e modello',
  hourly_cost: 'costo orario',
  active: 'in uso',
  notes: 'note',
}

/** Kinds by normalized name: the labels of exportVehicles and a few common words. */
const KINDS: Record<string, string> = {
  '': 'vehicle',
  automezzo: 'vehicle',
  automezzi: 'vehicle',
  veicolo: 'vehicle',
  vehicle: 'vehicle',
  macchinaoperatrice: 'machine',
  macchina: 'machine',
  mezzodopera: 'machine',
  machine: 'machine',
  attrezzatura: 'equipment',
  attrezzo: 'equipment',
  equipment: 'equipment',
}

/** "targa: message" for each field error of parseVehicleInput. */
export function vehicleRowMessages(errors: FieldErrors): string[] {
  return Object.entries(errors).flatMap(([field, list]) =>
    list.map((m) => `${FIELD_NAMES[field as Field] ?? field}: ${m}`),
  )
}

/**
 * Reads a CSV file of vehicles, each row checked by `parse` (parseVehicleInput) as a new
 * vehicle would be. Duplicate plates against the database are found when inserting.
 */
export function parseVehiclesCsv<T>(
  body: Buffer,
  parse: (body: unknown) => { input: T } | { errors: FieldErrors },
): ImportedRow<T>[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  if (!positions.has('name')) {
    throw new ImportFailed({ file: ['Nella prima riga manca la colonna nome.'] })
  }
  if (rows.length === 0) throw new ImportFailed({ file: ['Il file non ha mezzi.'] })
  if (rows.length > MAX_VEHICLE_IMPORT_ROWS) {
    throw new ImportFailed({ file: [`Al massimo ${MAX_VEHICLE_IMPORT_ROWS} mezzi per file.`] })
  }

  const errors = new RowErrors()
  const vehicles: ImportedRow<T>[] = []
  for (const record of rows) {
    const cell = (field: Field) => {
      const index = positions.get(field)
      return index === undefined ? '' : (record.fields[index] ?? '').trim()
    }
    const input: Record<string, unknown> = {}
    for (const field of FIELDS) input[field] = cell(field)
    const problems: string[] = []

    const kind = KINDS[normalizeHeader(cell('kind'))]
    if (kind) input.kind = kind
    else problems.push('tipo: Automezzo, Macchina operatrice oppure Attrezzatura.')
    const cost = cell('hourly_cost')
    if (cost !== '') {
      const cents = parsePrice(cost)
      if (cents === null) problems.push('costo orario: importo non valido (es. 45,00).')
      else input.hourly_cost = centsToAmount(cents)
    }
    const active = readYesNo(cell('active'), true)
    if (active === null) problems.push('in uso: sì oppure no.')
    else input.active = active

    if (problems.length > 0) {
      errors.add(record.line, problems)
      continue
    }
    const parsed = parse(input)
    if ('errors' in parsed) errors.add(record.line, vehicleRowMessages(parsed.errors))
    else vehicles.push({ line: record.line, input: parsed.input })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  return vehicles
}
