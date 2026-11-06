/**
 * Italian tax identifiers: partita IVA and codice fiscale, with their check characters.
 */

/** Uppercase, no spaces or dots, no "IT" prefix. */
export function normalizeTaxId(value: string): string {
  const compact = value.replace(/[\s.-]/g, '').toUpperCase()
  return compact.startsWith('IT') && /^IT\d{11}$/.test(compact) ? compact.slice(2) : compact
}

/** Partita IVA: 11 digits, the last one is a check digit (also used by numeric codici fiscali). */
export function isValidPartitaIva(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let digit = Number(value[i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return (10 - (sum % 10)) % 10 === Number(value[10])
}

export function partitaIvaCheckDigit(first10: string): string {
  for (let digit = 0; digit <= 9; digit++) {
    if (isValidPartitaIva(`${first10}${digit}`)) return String(digit)
  }
  throw new Error('unreachable')
}

// Values of characters in odd positions (1st, 3rd, ...) for the check letter.
const ODD: Record<string, number> = {
  '0': 1,
  '1': 0,
  '2': 5,
  '3': 7,
  '4': 9,
  '5': 13,
  '6': 15,
  '7': 17,
  '8': 19,
  '9': 21,
  A: 1,
  B: 0,
  C: 5,
  D: 7,
  E: 9,
  F: 13,
  G: 15,
  H: 17,
  I: 19,
  J: 21,
  K: 2,
  L: 4,
  M: 18,
  N: 20,
  O: 11,
  P: 3,
  Q: 6,
  R: 8,
  S: 12,
  T: 14,
  U: 16,
  V: 10,
  W: 22,
  X: 25,
  Y: 24,
  Z: 23,
}

// Omocodia replaces digits with these letters, so they are allowed where digits go.
const DIGIT = '[0-9LMNPQRSTUV]'
const PERSONAL_FORMAT = new RegExp(
  `^[A-Z]{6}${DIGIT}{2}[ABCDEHLMPRST]${DIGIT}{2}[A-Z]${DIGIT}{3}[A-Z]$`,
)

export function codiceFiscaleCheckLetter(first15: string): string {
  let sum = 0
  for (let i = 0; i < 15; i++) {
    const char = first15[i] ?? ''
    if (i % 2 === 0) {
      sum += ODD[char] ?? 0
    } else {
      sum += /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65
    }
  }
  return String.fromCharCode(65 + (sum % 26))
}

/** Personal codice fiscale: 16 characters with a check letter. */
export function isValidPersonalCodiceFiscale(value: string): boolean {
  return PERSONAL_FORMAT.test(value) && codiceFiscaleCheckLetter(value.slice(0, 15)) === value[15]
}

/** Any codice fiscale: personal (16 characters) or of an organisation (11 digits). */
export function isValidCodiceFiscale(value: string): boolean {
  return value.length === 11 ? isValidPartitaIva(value) : isValidPersonalCodiceFiscale(value)
}
