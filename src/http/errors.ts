/**
 * Every error leaves the API in the contract's shape: { message, code? } or, for 422,
 * { message, errors: { field: [messages] } }. Messages are Italian and shown as they are.
 */

export type FieldErrors = Record<string, string[]>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export class ValidationFailed extends Error {
  readonly status = 422
  constructor(
    readonly errors: FieldErrors,
    message = 'Controlla i dati inseriti.',
  ) {
    super(message)
  }
}

export const messages = {
  sessionExpired: 'Sessione scaduta: accedi di nuovo.',
  badCsrf: 'Token di sicurezza non valido: ricarica la pagina.',
  notFound: 'Non trovato, oppure non hai accesso.',
  notAllowed: 'Il tuo ruolo non permette questa azione.',
  tooManyAttempts: 'Troppi tentativi di accesso. Riprova tra qualche minuto.',
  staleRecord:
    'Il cliente è stato modificato da qualcun altro. Ricarica la scheda per vedere le modifiche.',
  missingIfMatch: 'Manca la versione del cliente: ricarica la scheda e riprova.',
  clientHasDocuments: 'Il cliente ha documenti collegati e non si può eliminare: puoi archiviarlo.',
  internal: 'Errore interno. Riprova tra poco.',
  badRequest: 'Richiesta non valida.',
} as const

export const unauthorized = () => new ApiError(401, messages.sessionExpired)
export const forbidden = () => new ApiError(403, messages.notAllowed)
export const notFound = () => new ApiError(404, messages.notFound)
export const csrfInvalid = () => new ApiError(403, messages.badCsrf, 'csrf_invalid')
