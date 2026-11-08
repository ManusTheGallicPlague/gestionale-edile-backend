/** Easter Sunday of a year (Gregorian calendar, anonymous algorithm), as month and day. */
export function easter(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

/** Italian national holidays, as MM-DD; the local patron saint is not among them. */
const FIXED = [
  '01-01',
  '01-06',
  '04-25',
  '05-01',
  '06-02',
  '08-15',
  '11-01',
  '12-08',
  '12-25',
  '12-26',
]

const cache = new Map<number, Set<string>>()

/** National holidays of a year as AAAA-MM-GG, Easter Monday included. */
export function nationalHolidays(year: number): Set<string> {
  let set = cache.get(year)
  if (!set) {
    const { month, day } = easter(year)
    const monday = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
    set = new Set([...FIXED.map((md) => `${year}-${md}`), monday])
    cache.set(year, set)
  }
  return set
}

const DAY = 86_400_000

/** Monday to Friday from day number `start` to `end` (days since 1970-01-01), both included. */
function weekdays(start: number, end: number): number {
  const days = end - start + 1
  if (days <= 0) return 0
  const weeks = Math.floor(days / 7)
  let count = weeks * 5
  // 1970-01-01 was a Thursday: day 0 has weekday 4 (Sunday = 0).
  for (let d = start + weeks * 7; d <= end; d++) {
    const weekday = (d + 4) % 7
    if (weekday !== 0 && weekday !== 6) count++
  }
  return count
}

/**
 * Working days from `from` to `to` (AAAA-MM-GG), both included: Monday to Friday, without the
 * national holidays. Zero if `to` is before `from`. Counts by weeks, so a long period costs
 * little: one pass on the holidays of each year.
 */
export function workingDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`) / DAY
  const end = Date.parse(`${to}T00:00:00Z`) / DAY
  let count = weekdays(start, end)
  if (count === 0) return 0
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const holiday of nationalHolidays(year)) {
      if (holiday < from || holiday > to) continue
      const weekday = new Date(`${holiday}T00:00:00Z`).getUTCDay()
      if (weekday !== 0 && weekday !== 6) count--
    }
  }
  return count
}
