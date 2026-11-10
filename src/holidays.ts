import type { PoolClient } from 'pg'
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

/** A day of the year as MM-DD, valid in every year (so never 02-29). */
export const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function isMonthDay(value: string): boolean {
  if (!MONTH_DAY.test(value)) return false
  return new Date(`2001-${value}T00:00:00Z`).toISOString().slice(5, 10) === value
}

/** The patron saint day of the current company (company profile), MM-DD or null. */
export async function patronSaintDay(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ day: string | null }>(
    `select patron_saint_day as day from public.company_profiles
     where company_id = app.current_company_id()`,
  )
  return rows[0]?.day ?? null
}

/**
 * Working days from `from` to `to` (AAAA-MM-GG), both included: Monday to Friday, without the
 * national holidays and the patron saint day (MM-DD) of the company, if given. Zero if `to`
 * is before `from`. Counts by weeks, so a long period costs little: one pass on the holidays
 * of each year.
 */
export function workingDays(from: string, to: string, patron: string | null = null): number {
  const start = Date.parse(`${from}T00:00:00Z`) / DAY
  const end = Date.parse(`${to}T00:00:00Z`) / DAY
  let count = weekdays(start, end)
  if (count === 0) return 0
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const holidays = nationalHolidays(year)
    const local = patron === null ? [] : [`${year}-${patron}`].filter((d) => !holidays.has(d))
    for (const holiday of [...holidays, ...local]) {
      if (holiday < from || holiday > to) continue
      const weekday = new Date(`${holiday}T00:00:00Z`).getUTCDay()
      if (weekday !== 0 && weekday !== 6) count--
    }
  }
  return count
}

/**
 * Holidays of a month (AAAA-MM) as AAAA-MM-GG: the national ones and the patron saint day of
 * the company. Sundays are not listed: callers check the weekday.
 */
export function holidaysOfMonth(month: string, patron: string | null): string[] {
  const year = Number(month.slice(0, 4))
  const all = [...nationalHolidays(year)]
  if (patron) all.push(`${year}-${patron}`)
  return all.filter((day) => day.startsWith(`${month}-`)).sort()
}

/** National holidays and the patron saint day of the years from `first` to `last`, AAAA-MM-GG. */
export function holidaysOfYears(first: number, last: number, patron: string | null): string[] {
  const all: string[] = []
  for (let year = first; year <= last; year++) {
    all.push(...nationalHolidays(year))
    if (patron) all.push(`${year}-${patron}`)
  }
  return all.sort()
}

/**
 * Whether a day (AAAA-MM-GG) is a holiday for the company: a Sunday, a national holiday (Easter
 * Monday included) or its patron saint day (MM-DD), if given.
 */
export function isHoliday(day: string, patron: string | null): boolean {
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) return true
  if (patron !== null && day.slice(5) === patron) return true
  return nationalHolidays(Number(day.slice(0, 4))).has(day)
}
