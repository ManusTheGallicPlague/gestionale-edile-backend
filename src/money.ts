/**
 * Amounts travel as strings ("1234.50") and live in the database as integer cents.
 * Conversion is done on the digits, never through JavaScript floating point.
 */

const AMOUNT = /^(\d{1,13})(?:\.(\d{1,2}))?$/

/** "1234.5" → "123450" (cents, as a string for a bigint column), or null if not an amount. */
export function amountToCents(value: string): string | null {
  const match = AMOUNT.exec(value)
  if (!match) return null
  const euros = (match[1] ?? '0').replace(/^0+(?=\d)/, '')
  const cents = (match[2] ?? '').padEnd(2, '0')
  return `${euros === '0' ? '' : euros}${cents}`.replace(/^0+(?=\d)/, '') || '0'
}

/** "123450" (bigint from pg) → "1234.50". */
export function centsToAmount(cents: string): string {
  const digits = cents.padStart(3, '0')
  return `${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`
}
