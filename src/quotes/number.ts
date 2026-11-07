/** The quote number as shown to users: 2026/001, or 2026/001-R1 for a revision; null in draft. */
export function formatQuoteNumber(
  year: number | null,
  seq: number | null,
  revision: number | null,
): string | null {
  if (year === null || seq === null) return null
  const base = `${year}/${String(seq).padStart(3, '0')}`
  return revision ? `${base}-R${revision}` : base
}
