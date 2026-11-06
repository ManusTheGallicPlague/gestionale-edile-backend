import type { FieldErrors } from '../http/errors.js'
import { amountToCents } from '../money.js'
import { isIsoDate } from '../suppliers/documents.js'

export const DEADLINE_KINDS = [
  'durc',
  'insurance',
  'tax',
  'invoice_in',
  'invoice_out',
  'contract',
  'vehicle',
  'other',
] as const
export type DeadlineKind = (typeof DEADLINE_KINDS)[number]

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What goes into the table: the amount already in cents. */
export interface DeadlineInput {
  title: string
  due_on: string
  kind: DeadlineKind
  amount_cents: string | null
  client_id: string | null
  supplier_id: string | null
  notes: string | null
}

export const DEADLINE_COLUMNS = [
  'title',
  'due_on',
  'kind',
  'amount_cents',
  'client_id',
  'supplier_id',
  'notes',
] as const satisfies readonly (keyof DeadlineInput)[]

export function parseDeadlineInput(
  body: unknown,
): { input: DeadlineInput } | { errors: FieldErrors } {
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

  const title = text('title')
  if (title === null && !errors.title) add('title', 'Il titolo è obbligatorio.')
  else if (title !== null && title.length > 200) add('title', 'Al massimo 200 caratteri.')

  const due_on = text('due_on')
  if (due_on === null && !errors.due_on) add('due_on', 'La data è obbligatoria.')
  else if (due_on !== null && !isIsoDate(due_on)) {
    add('due_on', 'Data non valida: usa il formato AAAA-MM-GG.')
  }

  const kindValue = text('kind')
  const kind = DEADLINE_KINDS.find((k) => k === kindValue)
  if (!kind && !errors.kind) add('kind', 'Scegli il tipo di scadenza.')

  const amount = text('amount')
  const amount_cents = amount === null ? null : amountToCents(amount)
  if (amount !== null && amount_cents === null) {
    add('amount', 'Importo non valido: usa il punto per i decimali, ad esempio 1234.50.')
  }

  const id = (field: 'client_id' | 'supplier_id') => {
    const value = text(field)
    if (value !== null && !UUID.test(value)) {
      add(field, 'Soggetto non trovato.')
      return null
    }
    return value
  }
  const client_id = id('client_id')
  const supplier_id = id('supplier_id')
  if (client_id && supplier_id) add('supplier_id', 'Collega un cliente oppure un fornitore.')

  const notes = text('notes')
  if (notes !== null && notes.length > 2000) add('notes', 'Al massimo 2000 caratteri.')

  if (Object.keys(errors).length > 0 || !kind || !title || !due_on) return { errors }
  return { input: { title, due_on, kind, amount_cents, client_id, supplier_id, notes } }
}
