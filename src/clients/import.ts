import type { FieldErrors } from '../http/errors.js'
import { ImportFailed, normalizeHeader, readCsv } from '../csv-import.js'
import { CLIENT_FIELDS, parseClientInput, type ClientInput, type ClientKind } from './input.js'

/** Most clients in one file. */
export const MAX_CLIENT_IMPORT_ROWS = 5000
const MAX_ROW_ERRORS = 50

type Field = (typeof CLIENT_FIELDS)[number]

/** Header names (normalized, see normalizeHeader) of each field, Italian first. */
const HEADERS: Record<string, Field> = {
  tipo: 'kind',
  kind: 'kind',
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
  codicesdi: 'sdi_code',
  sdi: 'sdi_code',
  codicedestinatario: 'sdi_code',
  sdicode: 'sdi_code',
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
  note: 'notes',
  notes: 'notes',
}

/** Italian names of the fields, to say in which column a row is wrong. */
export const CLIENT_FIELD_NAMES: Record<Field, string> = {
  kind: 'tipo',
  name: 'nome',
  vat_number: 'partita IVA',
  tax_code: 'codice fiscale',
  email: 'email',
  pec: 'PEC',
  phone: 'telefono',
  sdi_code: 'codice SDI',
  street: 'indirizzo',
  postal_code: 'CAP',
  city: 'città',
  province: 'provincia',
  country: 'paese',
  notes: 'note',
}

const KINDS: Record<string, ClientKind> = {
  '': 'company',
  azienda: 'company',
  impresa: 'company',
  societa: 'company',
  company: 'company',
  persona: 'person',
  personafisica: 'person',
  privato: 'person',
  person: 'person',
  ente: 'public_body',
  entepubblico: 'public_body',
  pa: 'public_body',
  pubblicaamministrazione: 'public_body',
  publicbody: 'public_body',
}

export interface ImportedClient {
  line: number
  input: ClientInput
}

/** Collects row errors as `row.<line>`, at most MAX_ROW_ERRORS rows. */
export class RowErrors {
  readonly errors: FieldErrors = {}
  private rows = 0
  add(line: number, messages: string[]) {
    const key = `row.${line}`
    if (!this.errors[key]) {
      if (this.rows >= MAX_ROW_ERRORS) return
      this.errors[key] = []
      this.rows++
    }
    this.errors[key].push(...messages)
  }
  get empty() {
    return this.rows === 0
  }
}

/** "partita IVA: message" for each field error of parseClientInput. */
export function rowMessages(errors: FieldErrors): string[] {
  return Object.entries(errors).flatMap(([field, list]) =>
    list.map((m) => `${CLIENT_FIELD_NAMES[field as Field] ?? field}: ${m}`),
  )
}

/**
 * Reads a CSV file of clients, each checked as a new client would be. Throws ImportFailed
 * listing what is wrong; duplicates against the database are found when inserting.
 */
export function parseClientsCsv(body: Buffer): ImportedClient[] {
  const { header, rows } = readCsv(body)
  const positions = new Map<Field, number>()
  header.forEach((name, index) => {
    const field = HEADERS[normalizeHeader(name)]
    if (field && !positions.has(field)) positions.set(field, index)
  })
  if (!positions.has('name')) {
    throw new ImportFailed({ file: ['Nella prima riga manca la colonna nome.'] })
  }
  if (rows.length === 0) throw new ImportFailed({ file: ['Il file non ha clienti.'] })
  if (rows.length > MAX_CLIENT_IMPORT_ROWS) {
    throw new ImportFailed({ file: [`Al massimo ${MAX_CLIENT_IMPORT_ROWS} clienti per file.`] })
  }

  const errors = new RowErrors()
  const clients: ImportedClient[] = []
  for (const record of rows) {
    const body: Record<string, string | null> = {}
    for (const field of CLIENT_FIELDS) {
      const index = positions.get(field)
      body[field] = index === undefined ? null : (record.fields[index] ?? '')
    }
    const kindText = normalizeHeader(body.kind ?? '')
    const kind = KINDS[kindText]
    if (!kind) {
      errors.add(record.line, ['tipo: azienda, persona o ente pubblico.'])
      continue
    }
    body.kind = kind
    if ((body.country ?? '').trim() === '') body.country = 'IT'
    const parsed = parseClientInput(body)
    if ('errors' in parsed) errors.add(record.line, rowMessages(parsed.errors))
    else clients.push({ line: record.line, input: parsed.input })
  }
  if (!errors.empty) throw new ImportFailed(errors.errors)
  return clients
}
