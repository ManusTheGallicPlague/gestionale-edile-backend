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

describe('contract', () => {
  it('every $ref points to an existing definition', () => {
    const broken = [...new Set(refs(doc))].filter(
      (ref) => !ref.startsWith('#/') || resolve(ref) === undefined,
    )
    expect(broken).toEqual([])
  })
})
