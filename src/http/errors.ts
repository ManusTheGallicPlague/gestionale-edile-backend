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
  supplierStale:
    'Il fornitore è stato modificato da qualcun altro. Ricarica la scheda per vedere le modifiche.',
  supplierMissingIfMatch: 'Manca la versione del fornitore: ricarica la scheda e riprova.',
  supplierHasDocuments:
    'Il fornitore ha documenti collegati e non si può eliminare: puoi archiviarlo.',
  documentStale:
    'Il documento è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  documentMissingIfMatch: 'Manca la versione del documento: ricarica la pagina e riprova.',
  deadlineStale:
    'La scadenza è stata modificata da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  deadlineMissingIfMatch: 'Manca la versione della scadenza: ricarica la pagina e riprova.',
  estimateStale:
    'Il computo è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  estimateMissingIfMatch: 'Manca la versione del computo: ricarica la pagina e riprova.',
  siteStale:
    'Il cantiere è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  siteMissingIfMatch: 'Manca la versione del cantiere: ricarica la pagina e riprova.',
  siteHasDocuments:
    'Il cantiere ha rapportini o altri documenti collegati e non si può eliminare: puoi chiuderlo.',
  vehicleHasDocuments:
    'Il mezzo compare in un rapportino e non si può eliminare: puoi segnarlo come non in uso.',
  reportStale:
    'Il rapportino è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  reportMissingIfMatch: 'Manca la versione del rapportino: ricarica la pagina e riprova.',
  reportNotDraft:
    'Il rapportino è già stato inviato e non si modifica più: va prima riportato in bozza.',
  reportInvalidTransition: 'Questo cambio di stato del rapportino non è ammesso.',
  employeeStale:
    'Il dipendente è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  employeeHasDocuments:
    'Il dipendente è in una squadra o ha documenti collegati e non si può eliminare: puoi segnarlo come non attivo.',
  employeeMissingIfMatch: 'Manca la versione del dipendente: ricarica la pagina e riprova.',
  vehicleStale:
    'Il mezzo è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  vehicleMissingIfMatch: 'Manca la versione del mezzo: ricarica la pagina e riprova.',
  chapterStale:
    'Il capitolo è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  itemStale:
    'La voce è stata modificata da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  measurementStale:
    'La riga di misura è stata modificata da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  structureStale:
    'Capitoli o voci sono stati modificati da qualcun altro. Ricarica la pagina e riprova.',
  structureMissingIfMatch: 'Manca la versione: ricarica la pagina e riprova.',
  quoteStale:
    'Il preventivo è stato modificato da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  quoteMissingIfMatch: 'Manca la versione del preventivo: ricarica la pagina e riprova.',
  quoteNotDraft: 'Il preventivo è già stato inviato e non si modifica più: fanne una revisione.',
  lineStale:
    'La riga è stata modificata da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  quoteNotRevisable:
    'Si fa la revisione solo di un preventivo inviato, rifiutato o scaduto: una bozza si modifica, uno accettato resta com’è.',
  quoteInvalidTransition:
    'Questo cambio di stato non è ammesso: una bozza si invia, un preventivo inviato riceve un esito.',
  settingsStale:
    'I dati dell’azienda sono stati modificati da qualcun altro. Ricarica la pagina per vedere le modifiche.',
  settingsMissingIfMatch: 'Manca la versione dei dati dell’azienda: ricarica la pagina e riprova.',
  numberInUse: (highest: number) =>
    `Il numero ${highest} di quell'anno è già stato usato: il prossimo deve essere almeno ${highest + 1}.`,
  internal: 'Errore interno. Riprova tra poco.',
  databaseUnavailable: 'Il database non risponde.',
  badRequest: 'Richiesta non valida.',
} as const

export const unauthorized = () => new ApiError(401, messages.sessionExpired)
export const forbidden = () => new ApiError(403, messages.notAllowed)
export const notFound = () => new ApiError(404, messages.notFound)
export const csrfInvalid = () => new ApiError(403, messages.badCsrf, 'csrf_invalid')
