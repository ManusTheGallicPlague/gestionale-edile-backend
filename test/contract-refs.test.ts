/**
 * Every $ref of the contract must point to something that exists. The response checks only
 * resolve the references they meet, so a broken one on an unused path went unnoticed and
 * broke the frontend's type generation (openapi-typescript).
 */
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const doc = parse(
  readFileSync(new URL('../contract/openapi.yaml', import.meta.url), 'utf8'),
) as unknown

function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refs(item, found)
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value)
      else refs(value, found)
    }
  }
  return found
}

function resolve(ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      doc,
    )
}

type Parameter = { name?: string; in?: string; schema?: { properties?: object } }
type Operation = { parameters?: ({ $ref?: string } & Parameter)[] }

/** Query parameters of a GET, except paging, with the filter[...] keys spelled out. */
function queryNames(operation: Operation): string[] {
  const names: string[] = []
  for (const raw of operation.parameters ?? []) {
    const p = (raw.$ref ? resolve(raw.$ref) : raw) as Parameter
    if (p.in !== 'query' || p.name === 'page' || p.name === 'per_page') continue
    if (p.name === 'filter') {
      for (const key of Object.keys(p.schema?.properties ?? {})) names.push(`filter[${key}]`)
    } else if (p.name) names.push(p.name)
  }
  return names.sort()
}

describe('contract', () => {
  it('every $ref points to an existing definition', () => {
    const broken = [...new Set(refs(doc))].filter(
      (ref) => !ref.startsWith('#/') || resolve(ref) === undefined,
    )
    expect(broken).toEqual([])
  })

  it('every CSV export takes the same filters, search and sort as its list', () => {
    const paths = (doc as { paths: Record<string, { get?: Operation }> }).paths
    const different = Object.entries(paths).flatMap(([path, item]) => {
      const list = paths[path.replace(/\/export$/, '')]?.get
      if (!path.endsWith('/export') || !item.get || !list) return []
      const [listed, exported] = [queryNames(list), queryNames(item.get)]
      return listed.join() === exported.join() ? [] : [{ path, listed, exported }]
    })
    expect(different).toEqual([])
  })
})
