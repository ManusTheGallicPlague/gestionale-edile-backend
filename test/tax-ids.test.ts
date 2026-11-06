import { describe, expect, it } from 'vitest'
import {
  codiceFiscaleCheckLetter,
  isValidCodiceFiscale,
  isValidPartitaIva,
  isValidPersonalCodiceFiscale,
  normalizeTaxId,
} from '../src/clients/tax-ids.js'
import { devClients } from '../scripts/seed-dev.js'

describe('partita IVA', () => {
  it.each(['01234567897', '11111111115', '00743110157'])('accepts %s', (vat) => {
    expect(isValidPartitaIva(vat)).toBe(true)
  })
  it.each(['01234567890', '1234567897', '0123456789A', ''])('refuses %s', (vat) => {
    expect(isValidPartitaIva(vat)).toBe(false)
  })
})

describe('codice fiscale', () => {
  it('accepts a personal code and computes its check letter', () => {
    expect(codiceFiscaleCheckLetter('RSSMRA80A01H501')).toBe('U')
    expect(isValidPersonalCodiceFiscale('RSSMRA80A01H501U')).toBe(true)
  })
  it('accepts omocodia, where digits become letters', () => {
    const first15 = 'RSSMRA80A01H50M'
    expect(isValidPersonalCodiceFiscale(first15 + codiceFiscaleCheckLetter(first15))).toBe(true)
  })
  it.each(['RSSMRA80A01H501X', 'RSSMRA80Z01H501U', 'RSSMRA80A01H501'])('refuses %s', (cf) => {
    expect(isValidPersonalCodiceFiscale(cf)).toBe(false)
  })
  it('accepts the numeric code of an organisation', () => {
    expect(isValidCodiceFiscale('90000000001')).toBe(true)
    expect(isValidCodiceFiscale('90000000002')).toBe(false)
  })
})

describe('normalization', () => {
  it.each([
    [' it 01234 567897 ', '01234567897'],
    ['IT01234567897', '01234567897'],
    ['rssmra80a01h501u', 'RSSMRA80A01H501U'],
    ['DE123456789', 'DE123456789'],
    ['ITALIA', 'ITALIA'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeTaxId(input)).toBe(expected)
  })
})

describe('development data', () => {
  it('has valid ids, so it passes the same checks as real input', () => {
    for (const client of devClients(60, 1)) {
      if (client.vat_number)
        expect(isValidPartitaIva(client.vat_number), client.vat_number).toBe(true)
      if (client.tax_code) expect(isValidCodiceFiscale(client.tax_code), client.tax_code).toBe(true)
    }
  })
})
