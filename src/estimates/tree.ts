/** The estimate's tree as the structure returns it, grouped for a walk in order. */
export interface EstimateTree {
  chapters: {
    id: string
    parent_id: string | null
    code: string | null
    title: string
    amount: string
  }[]
  /** In the order of their chapter. */
  items: {
    id: string
    chapter_id: string
    code: string | null
    description: string
    unit: string
    unit_price: string
    quantity: string
    amount: string
  }[]
  /** In the order of their item. */
  measurements: {
    item_id: string
    description: string | null
    equal_parts: string | null
    length: string | null
    width: string | null
    height: string | null
    quantity: string
  }[]
}

export type TreeChapter = EstimateTree['chapters'][number]
export type TreeItem = EstimateTree['items'][number]
export type TreeMeasurement = EstimateTree['measurements'][number]

function groupBy<T, K>(list: T[], key: (value: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const value of list) {
    const group = map.get(key(value))
    if (group) group.push(value)
    else map.set(key(value), [value])
  }
  return map
}

/** Sub-chapters (null: the first level), items and measurement rows by their parent. */
export function groupTree(tree: EstimateTree) {
  return {
    children: groupBy(tree.chapters, (c) => c.parent_id),
    itemsOf: groupBy(tree.items, (i) => i.chapter_id),
    measurementsOf: groupBy(tree.measurements, (m) => m.item_id),
  }
}
