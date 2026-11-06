import type { FieldErrors } from '../http/errors.js'

export const DOCUMENT_KINDS = ['durc', 'chamber_extract', 'insurance', 'other'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export interface DocumentInput {
  kind: DocumentKind
  description: string | null
  issued_on: string | null
  expires_on: string | null
  notes: string | null
}

export const DOCUMENT_FIELDS = [
  'kind',
  'description',
  'issued_on',
  'expires_on',
  'notes',
] as const satisfies readonly (keyof DocumentInput)[]

/** A real calendar day written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseDocumentInput(
  body: unknown,
): { input: DocumentInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: { _: ['Il corpo della richiesta deve essere un oggetto JSON.'] } }
  }
  const raw = body as Record<string, unknown>
  const text = (field: keyof DocumentInput): string | null => {
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
  const kind = DOCUMENT_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Scegli il tipo di documento.')

  const description = text('description')
  if (description !== null && description.length > 200)
    add('description', 'Al massimo 200 caratteri.')
  if (kind === 'other' && description === null && !errors.description) {
    add('description', 'Descrivi il documento.')
  }

  const date = (field: 'issued_on' | 'expires_on') => {
    const value = text(field)
    if (value !== null && !isIsoDate(value)) {
      add(field, 'Data non valida: usa il formato AAAA-MM-GG.')
      return null
    }
    return value
  }
  const issued_on = date('issued_on')
  const expires_on = date('expires_on')
  if (issued_on && expires_on && expires_on < issued_on) {
    add('expires_on', 'La scadenza non può essere prima del rilascio.')
  }

  const notes = text('notes')
  if (notes !== null && notes.length > 2000) add('notes', 'Al massimo 2000 caratteri.')

  if (Object.keys(errors).length > 0 || !kind) return { errors }
  return { input: { kind, description, issued_on, expires_on, notes } }
}
