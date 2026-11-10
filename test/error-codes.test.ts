/**
 * Every `code` the API can send must be listed in the contract (Error.code), where the
 * frontend looks for the cases to recognise. The list had fallen behind the code.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const doc = parse(readFileSync(new URL('../contract/openapi.yaml', import.meta.url), 'utf8')) as {
  components: { schemas: { Error: { properties: { code: { description: string } } } } }
}

function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, found)
    else if (path.endsWith('.ts')) found.push(readFileSync(path, 'utf8'))
  }
  return found
}

function codesInSource(): Set<string> {
  const codes = new Set<string>()
  for (const text of sources(fileURLToPath(new URL('../src', import.meta.url)))) {
    for (const match of text.matchAll(/new ApiError\(\s*\d{3},\s*[^,]+?,\s*'([a-z_]+)'/g)) {
      codes.add(match[1] ?? '')
    }
    for (const match of text.matchAll(/message: [^,]+, code: '([a-z_]+)'/g)) {
      codes.add(match[1] ?? '')
    }
  }
  return codes
}

describe('error codes', () => {
  it('lists in the contract every code the API sends', () => {
    const codes = codesInSource()
    expect(codes.size).toBeGreaterThan(15)
    expect(codes).toContain('database_unavailable')
    const listed = new Set(
      doc.components.schemas.Error.properties.code.description.match(/[a-z]+(?:_[a-z]+)+/g),
    )
    expect([...codes].filter((code) => !listed.has(code)).sort()).toEqual([])
  })
})
