import type { FieldErrors } from '../http/errors.js'
import { isValidCodiceFiscale, isValidPartitaIva, normalizeTaxId } from '../clients/tax-ids.js'

export const SUPPLIER_CATEGORIES = [
  'materials',
  'rentals',
  'subcontracting',
  'services',
  'other',
] as const
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number]

export interface SupplierInput {
  name: string
  vat_number: string | null
  tax_code: string | null
  email: string | null
  pec: string | null
  phone: string | null
  street: string | null
  postal_code: string | null
  city: string | null
  province: string | null
  country: string
  categories: SupplierCategory[]
  subcontractor: boolean
  notes: string | null
}

export const SUPPLIER_FIELDS = [
  'name',
  'vat_number',
  'tax_code',
  'email',
  'pec',
  'phone',
  'street',
  'postal_code',
  'city',
  'province',
  'country',
  'categories',
  'subcontractor',
  'notes',
] as const satisfies readonly (keyof SupplierInput)[]

type TextField = Exclude<keyof SupplierInput, 'categories' | 'subcontractor'>

const MAX: Partial<Record<TextField, number>> = {
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
 * Reads a supplier from the request body, with the same rules as a client: every field
 * present (null when empty), text trimmed, tax ids normalized. Returns the input or the errors.
 */
export function parseSupplierInput(
  body: unknown,
): { input: SupplierInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>

  const text = (field: TextField): string | null => {
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

  const categories: SupplierCategory[] = []
  if (!('categories' in raw)) add('categories', 'Campo mancante.')
  else if (!Array.isArray(raw.categories)) add('categories', 'Deve essere un elenco.')
  else {
    for (const value of raw.categories as unknown[]) {
      const category = SUPPLIER_CATEGORIES.find((c) => c === value)
      if (!category) {
        add('categories', 'Categoria non valida.')
        break
      }
      if (!categories.includes(category)) categories.push(category)
    }
  }

  let subcontractor = false
  if (!('subcontractor' in raw)) add('subcontractor', 'Campo mancante.')
  else if (typeof raw.subcontractor !== 'boolean') add('subcontractor', 'Vale true oppure false.')
  else subcontractor = raw.subcontractor

  const input: SupplierInput = {
    name: name ?? '',
    vat_number: vatRaw === null ? null : normalizeTaxId(vatRaw),
    tax_code: taxRaw === null ? null : normalizeTaxId(taxRaw),
    email: text('email')?.toLowerCase() ?? null,
    pec: text('pec')?.toLowerCase() ?? null,
    phone: text('phone'),
    street: text('street'),
    postal_code: text('postal_code'),
    city: text('city'),
    province: text('province')?.toUpperCase() ?? null,
    country: country ?? 'IT',
    categories,
    subcontractor,
    notes: text('notes'),
  }

  for (const [field, max] of Object.entries(MAX) as [TextField, number][]) {
    const value = input[field]
    if (typeof value === 'string' && value.length > max && !errors[field]) {
      add(field, `Al massimo ${max} caratteri.`)
    }
  }

  if (italian) {
    const { vat_number, tax_code } = input
    if (vat_number !== null && !errors.vat_number && !isValidPartitaIva(vat_number)) {
      add('vat_number', 'Partita IVA non valida.')
    }
    if (tax_code !== null && !errors.tax_code && !isValidCodiceFiscale(tax_code)) {
      add('tax_code', 'Codice fiscale non valido.')
    }
    if (vat_number === null && tax_code === null && !errors.vat_number && !errors.tax_code) {
      add('vat_number', 'Indica la partita IVA o il codice fiscale.')
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

  return Object.keys(errors).length > 0 ? { errors } : { input }
}
