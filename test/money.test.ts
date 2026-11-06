import { describe, expect, it } from 'vitest'
import { amountToCents, centsToAmount } from '../src/money.js'

describe('money', () => {
  it.each([
    ['0', '0'],
    ['0.5', '50'],
    ['0.05', '5'],
    ['1234.5', '123450'],
    ['1234.56', '123456'],
    ['007.10', '710'],
    ['9999999999999.99', '999999999999999'],
  ])('%s euro is %s cents', (amount, cents) => {
    expect(amountToCents(amount)).toBe(cents)
  })

  it.each(['', '1,50', '1.555', '-1', '1e3', ' 1', '.5', '12345678901234'])(
    'refuses %j',
    (value) => {
      expect(amountToCents(value)).toBeNull()
    },
  )

  it.each([
    ['0', '0.00'],
    ['5', '0.05'],
    ['50', '0.50'],
    ['123456', '1234.56'],
    ['999999999999999', '9999999999999.99'],
    ['-5', '-0.05'],
    ['-123456', '-1234.56'],
  ])('%s cents read as %s', (cents, amount) => {
    expect(centsToAmount(cents)).toBe(amount)
  })
})
