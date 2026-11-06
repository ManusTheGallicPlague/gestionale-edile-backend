import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from '../scripts/migrate.js'

describe('migrations directory', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const expected = path.join(root, 'db', 'migrations')

  it('is found from the sources and from the compiled script', () => {
    expect(migrationsDir(path.join(root, 'scripts'))).toBe(expected)
    // The production image runs dist/scripts/migrate.js: it once looked in dist/db.
    expect(migrationsDir(path.join(root, 'dist', 'scripts'))).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })
})
