import { describe, expect, it } from 'vitest'
import { easter, nationalHolidays, workingDays } from '../src/holidays.js'

describe('Italian national holidays', () => {
  it('finds Easter Sunday', () => {
    expect(easter(2024)).toEqual({ month: 3, day: 31 })
    expect(easter(2025)).toEqual({ month: 4, day: 20 })
    expect(easter(2026)).toEqual({ month: 4, day: 5 })
    expect(easter(2027)).toEqual({ month: 3, day: 28 })
    expect(easter(2038)).toEqual({ month: 4, day: 25 })
  })

  it('lists the eleven national holidays with Easter Monday', () => {
    const days = [...nationalHolidays(2026)].sort()
    expect(days).toEqual([
      '2026-01-01',
      '2026-01-06',
      '2026-04-06',
      '2026-04-25',
      '2026-05-01',
      '2026-06-02',
      '2026-08-15',
      '2026-11-01',
      '2026-12-08',
      '2026-12-25',
      '2026-12-26',
    ])
    // Easter Monday in the next month.
    expect(nationalHolidays(2024).has('2024-04-01')).toBe(true)
  })

  it('counts Monday to Friday without the holidays, both ends included', () => {
    expect(workingDays('2026-08-10', '2026-08-21')).toBe(10) // 15/08 is a Saturday
    expect(workingDays('2027-08-09', '2027-08-20')).toBe(10) // 15/08 is a Sunday, 16/08 is no holiday
    expect(workingDays('2026-04-06', '2026-04-06')).toBe(0) // Easter Monday
    expect(workingDays('2026-12-21', '2027-01-08')).toBe(12) // Christmas, Boxing Day, New Year, Epiphany
    expect(workingDays('2026-11-07', '2026-11-08')).toBe(0) // a weekend
    expect(workingDays('2026-11-09', '2026-11-09')).toBe(1)
    expect(workingDays('2026-11-10', '2026-11-09')).toBe(0)
    expect(workingDays('2026-01-01', '2026-12-31')).toBe(254) // 261 weekdays, 7 holidays on them
  })

  it('counts a very long period quickly and like day by day', () => {
    const slow = (from: string, to: string) => {
      let count = 0
      for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
        const d = new Date(t)
        const iso = d.toISOString().slice(0, 10)
        const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6
        if (!weekend && !nationalHolidays(d.getUTCFullYear()).has(iso)) count++
      }
      return count
    }
    for (const [from, to] of [
      ['2024-02-26', '2024-03-05'],
      ['2025-12-24', '2027-01-07'],
      ['2026-11-05', '2026-11-17'],
    ] as const) {
      expect(workingDays(from, to)).toBe(slow(from, to))
    }
    const started = Date.now()
    expect(workingDays('2000-01-01', '9999-12-31')).toBeGreaterThan(2_000_000)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
