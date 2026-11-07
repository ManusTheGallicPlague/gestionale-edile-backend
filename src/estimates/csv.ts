import { toCsv, type Cell } from '../csv.js'
import { groupTree, type EstimateTree, type TreeChapter } from './tree.js'

export const ESTIMATE_CSV_HEADER = [
  'Tipo',
  'Livello',
  'N.',
  'Codice',
  'Descrizione',
  'Unità',
  'Parti uguali',
  'Lunghezza',
  'Larghezza',
  'Altezza/peso',
  'Quantità',
  'Prezzo',
  'Importo',
]

/** "1234.50" → "1234,50": the decimal comma of Italian spreadsheets, no grouping. */
const comma = (value: string | null) => (value === null ? null : value.replace('.', ','))

/**
 * The estimate in CSV, in the order of the tree: a row per chapter (with its level and
 * amount), then its items, each followed by its measurement rows, then its sub-chapters;
 * a last row with the total.
 */
export function estimateCsv(tree: EstimateTree & { total: string }): string {
  const { children, itemsOf, measurementsOf } = groupTree(tree)
  const rows: Cell[][] = []
  let number = 0
  const chapter = (c: TreeChapter, level: number) => {
    rows.push([
      'Capitolo',
      level,
      null,
      c.code,
      c.title,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      comma(c.amount),
    ])
    for (const it of itemsOf.get(c.id) ?? []) {
      number += 1
      rows.push([
        'Voce',
        level,
        number,
        it.code,
        it.description,
        it.unit,
        null,
        null,
        null,
        null,
        comma(it.quantity),
        comma(it.unit_price),
        comma(it.amount),
      ])
      for (const m of measurementsOf.get(it.id) ?? []) {
        rows.push([
          'Misura',
          level,
          null,
          null,
          m.description,
          null,
          comma(m.equal_parts),
          comma(m.length),
          comma(m.width),
          comma(m.height),
          comma(m.quantity),
          null,
          null,
        ])
      }
    }
    for (const sub of children.get(c.id) ?? []) chapter(sub, level + 1)
  }
  for (const c of children.get(null) ?? []) chapter(c, 1)
  rows.push([
    'Totale',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    comma(tree.total),
  ])
  return toCsv(ESTIMATE_CSV_HEADER, rows)
}
