/**
 * A minimal iCalendar (RFC 5545) writer for all-day events: enough for a phone calendar to
 * import the deadlines. Lines end with CRLF and are folded at 75 octets without splitting a
 * UTF-8 character.
 */

export interface AllDayEvent {
  uid: string
  /** YYYY-MM-DD */
  date: string
  /** Last day, included (YYYY-MM-DD); the same day when missing. */
  lastDate?: string
  summary: string
  description: string
  /** When the event last changed, for DTSTAMP. */
  stamp: Date
  /** A reminder at 9 in the morning of the day before; on when missing. */
  alarm?: boolean
}

/** TEXT values: backslash, semicolon, comma and newlines are escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

export function foldLine(line: string): string {
  const parts: string[] = []
  let current = ''
  let octets = 0
  // The first line holds 75 octets, the following ones 74 after the leading space.
  let limit = 75
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8')
    if (octets + size > limit) {
      parts.push(current)
      current = ''
      octets = 0
      limit = 74
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const compactDate = (date: string) => date.replace(/-/g, '')

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const utcStamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')

export function toICalendar(
  calendarName: string,
  events: AllDayEvent[],
  product = 'Scadenze',
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Gestionale edile//${product}//IT`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ]
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${utcStamp(e.stamp)}`,
      `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
      // DTEND of all-day events is exclusive: the day after the last one.
      `DTEND;VALUE=DATE:${compactDate(nextDay(e.lastDate ?? e.date))}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      'TRANSP:TRANSPARENT',
    )
    if (e.alarm !== false) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(e.summary)}`,
        // Midnight of the day minus 15 hours: 9 in the morning of the day before.
        'TRIGGER:-PT15H',
        'END:VALARM',
      )
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
