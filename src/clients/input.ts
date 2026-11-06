import type { FieldErrors } from '../http/errors.js'
import {
  isValidCodiceFiscale,
  isValidPartitaIva,
  isValidPersonalCodiceFiscale,
  normalizeTaxId,
} from './tax-ids.js'

export const CLIENT_KINDS = ['company', 'person', 'public_body'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

export interface ClientInput {
  kind: ClientKind
  name: string
  vat_number: string | null
  tax_code: string | null
  email: string | null
  pec: string | null
  phone: string | null
  sdi_code: string | null
  street: string | null
  postal_code: string | null
  city: string | null
  province: string | null
  country: string
  notes: string | null
}

export const CLIENT_FIELDS = [
  'kind',
  'name',
  'vat_number',
  'tax_code',
  'email',
  'pec',
  'phone',
  'sdi_code',
  'street',
  'postal_code',
  'city',
  'province',
  'country',
  'notes',
] as const satisfies readonly (keyof ClientInput)[]

const MAX: Partial<Record<keyof ClientInput, number>> = {
  name: 200,
  vat_number: 20,
  tax_code: 16,
  email: 254,
  pec: 254,
  phone: 30,
  street: 200,
  postal_code: 10,
  city: 100,
  notes: 2000,
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Reads a client from the request body: every field must be present (null when empty),
 * as the contract says. Text is trimmed, empty strings become null, tax ids are normalized.
 * Returns the clean input, or the errors by field.
 */
export function parseClientInput(body: unknown): { input: ClientInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>

  const text = (field: keyof ClientInput): string | null => {
    if (!(field in raw)) {
      add(field, 'Campo mancante.')
      return null
    }
    const value = raw[field]
    if (value === null) return null
    if (typeof value !== 'string') {
      add(field, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }

  const kindValue = text('kind')
  const kind = CLIENT_KINDS.find((k) => k === kindValue)
  if (kindValue !== null && !kind) add('kind', 'Tipo di cliente non valido.')
  if (!('kind' in raw) || raw.kind === null) {
    if (!errors.kind) add('kind', 'Scegli il tipo di cliente.')
  }

  const name = text('name')
  if (name === null && !errors.name) add('name', 'Il nome è obbligatorio.')

  const countryValue = text('country')
  const country = countryValue?.toUpperCase() ?? null
  if (country === null && !errors.country) add('country', 'Il paese è obbligatorio.')
  else if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    add('country', 'Usa il codice di due lettere del paese, ad esempio IT.')
  }
  const italian = country === 'IT'

  const vatRaw = text('vat_number')
  const taxRaw = text('tax_code')
  const vat_number = vatRaw === null ? null : normalizeTaxId(vatRaw)
  const tax_code = taxRaw === null ? null : normalizeTaxId(taxRaw)

  const input: ClientInput = {
    kind: kind ?? 'company',
    name: name ?? '',
    vat_number,
    tax_code,
    email: text('email')?.toLowerCase() ?? null,
    pec: text('pec')?.toLowerCase() ?? null,
    phone: text('phone'),
    sdi_code: text('sdi_code')?.toUpperCase() ?? null,
    street: text('street'),
    postal_code: text('postal_code'),
    city: text('city'),
    province: text('province')?.toUpperCase() ?? null,
    country: country ?? 'IT',
    notes: text('notes'),
  }

  for (const [field, max] of Object.entries(MAX) as [keyof ClientInput, number][]) {
    const value = input[field]
    if (typeof value === 'string' && value.length > max && !errors[field]) {
      add(field, `Al massimo ${max} caratteri.`)
    }
  }

  if (italian && kind) {
    if (vat_number !== null && !errors.vat_number && !isValidPartitaIva(vat_number)) {
      add('vat_number', 'Partita IVA non valida.')
    }
    if (tax_code !== null && !errors.tax_code) {
      const valid =
        kind === 'person' ? isValidPersonalCodiceFiscale(tax_code) : isValidCodiceFiscale(tax_code)
      if (!valid) add('tax_code', 'Codice fiscale non valido.')
    }
    if (kind === 'person' && tax_code === null && !errors.tax_code) {
      add('tax_code', 'Il codice fiscale è obbligatorio per un privato.')
    }
    if (kind !== 'person' && vat_number === null && tax_code === null) {
      if (!errors.vat_number) add('vat_number', 'Indica la partita IVA o il codice fiscale.')
    }
    if (input.postal_code !== null && !errors.postal_code && !/^\d{5}$/.test(input.postal_code)) {
      add('postal_code', 'Il CAP è di 5 cifre.')
    }
    if (input.province !== null && !errors.province && !/^[A-Z]{2}$/.test(input.province)) {
      add('province', 'Usa la sigla di due lettere, ad esempio TO.')
    }
  } else if (input.province !== null && !errors.province && input.province.length > 2) {
    add('province', 'Al massimo 2 caratteri.')
  }

  for (const field of ['email', 'pec'] as const) {
    const value = input[field]
    if (value !== null && !errors[field] && !EMAIL.test(value)) add(field, 'Indirizzo non valido.')
  }
  if (input.phone !== null && !errors.phone && !/^[0-9+()./ -]+$/.test(input.phone)) {
    add('phone', 'Il telefono può contenere solo numeri, spazi e + ( ) . / -')
  }
  if (input.sdi_code !== null && !errors.sdi_code && !/^[A-Z0-9]{6,7}$/.test(input.sdi_code)) {
    add('sdi_code', 'Il codice destinatario è di 7 caratteri, 6 per la pubblica amministrazione.')
  }

  return Object.keys(errors).length > 0 ? { errors } : { input }
}
