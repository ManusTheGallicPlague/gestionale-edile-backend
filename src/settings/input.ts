import { amountToCents } from '../money.js'
import { isValidCodiceFiscale, isValidPartitaIva, normalizeTaxId } from '../clients/tax-ids.js'
import type { FieldErrors } from '../http/errors.js'
import { isMonthDay } from '../holidays.js'

export interface ProfileInput {
  legal_name: string
  vat_number: string | null
  tax_code: string | null
  rea: string | null
  share_capital_cents: string | null
  street: string | null
  postal_code: string | null
  city: string | null
  province: string | null
  country: string
  phone: string | null
  email: string | null
  pec: string | null
  iban: string | null
}

export const PROFILE_FIELDS = [
  'legal_name',
  'vat_number',
  'tax_code',
  'rea',
  'share_capital_cents',
  'street',
  'postal_code',
  'city',
  'province',
  'country',
  'phone',
  'email',
  'pec',
  'iban',
] as const

const MAX: Partial<Record<keyof ProfileInput, number>> = {
  legal_name: 200,
  vat_number: 20,
  tax_code: 16,
  rea: 30,
  street: 200,
  postal_code: 10,
  city: 100,
  phone: 30,
  email: 254,
  pec: 254,
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** IBAN check digits (ISO 13616): the rearranged number modulo 97 must be 1. */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  if (iban.startsWith('IT') && iban.length !== 27) return false
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  )
  let rest = 0
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97
  return rest === 1
}

/** Every field must be present (null when empty), as for clients. */
/** The profile, and the patron saint day when sent (missing: it stays as it is). */
export function parseProfile(
  body: unknown,
): { input: ProfileInput; patron?: string | null } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>
  const text = (field: string): string | null => {
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

  const legal_name = text('legal_name')
  if (legal_name === null && !errors.legal_name)
    add('legal_name', 'La ragione sociale è obbligatoria.')
  const country = text('country')?.toUpperCase() ?? null
  if (country === null && !errors.country) add('country', 'Il paese è obbligatorio.')
  else if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    add('country', 'Usa il codice di due lettere del paese, ad esempio IT.')
  }
  const vat = text('vat_number')
  const tax = text('tax_code')
  const capital = text('share_capital')
  let share_capital_cents: string | null = null
  if (capital !== null) {
    share_capital_cents = amountToCents(capital)
    if (share_capital_cents === null) add('share_capital', 'Un importo come 10000.00.')
  }
  const iban = text('iban')?.replace(/\s+/g, '').toUpperCase() ?? null

  const input: ProfileInput = {
    legal_name: legal_name ?? '',
    vat_number: vat === null ? null : normalizeTaxId(vat),
    tax_code: tax === null ? null : normalizeTaxId(tax),
    rea: text('rea')?.toUpperCase() ?? null,
    share_capital_cents,
    street: text('street'),
    postal_code: text('postal_code'),
    city: text('city'),
    province: text('province')?.toUpperCase() ?? null,
    country: country ?? 'IT',
    phone: text('phone'),
    email: text('email')?.toLowerCase() ?? null,
    pec: text('pec')?.toLowerCase() ?? null,
    iban,
  }
  for (const [field, max] of Object.entries(MAX) as [keyof ProfileInput, number][]) {
    const value = input[field]
    if (typeof value === 'string' && value.length > max && !errors[field]) {
      add(field, `Al massimo ${max} caratteri.`)
    }
  }
  if (country === 'IT') {
    if (input.vat_number !== null && !errors.vat_number && !isValidPartitaIva(input.vat_number)) {
      add('vat_number', 'Partita IVA non valida.')
    }
    if (input.tax_code !== null && !errors.tax_code && !isValidCodiceFiscale(input.tax_code)) {
      add('tax_code', 'Codice fiscale non valido.')
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
  if (iban !== null && !errors.iban && !isValidIban(iban)) add('iban', 'IBAN non valido.')
  let patron: string | null | undefined
  if ('patron_saint_day' in raw) {
    const value = raw.patron_saint_day
    if (value === null) patron = null
    else if (typeof value === 'string' && isMonthDay(value)) patron = value
    else add('patron_saint_day', 'Un giorno come MM-GG, ad esempio 06-29, o null.')
  }
  if (Object.keys(errors).length > 0) return { errors }
  return patron === undefined ? { input } : { input, patron }
}
