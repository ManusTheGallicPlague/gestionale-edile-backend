import type { PoolClient } from 'pg'
import { ApiError } from './errors.js'

/**
 * The files of a company live in the database, so each company has a total limit
 * (Config.storageLimitBytes): one company alone must not fill the disk of the server.
 * The space used is app.company_storage_bytes(), which counts every file of the declared
 * company whatever the user may read.
 */

/** Bytes taken by the files of the declared company. */
export async function storageUsed(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ bytes: string }>(
    'select app.company_storage_bytes()::text as bytes',
  )
  return Number(rows[0]?.bytes ?? '0')
}

/**
 * Locks the storage of the declared company until the transaction ends: two uploads at the
 * same time are counted one after the other, and the second sees the first once committed.
 */
export async function lockStorage(client: PoolClient): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('company_storage:' || app.current_company_id()::text, 0))",
  )
}

/** 413 storage_full if `bytes` more (fewer when negative) would go over the limit. */
export async function checkStorage(client: PoolClient, limit: number, bytes: number) {
  if ((await storageUsed(client)) + bytes > limit) {
    const message = `Lo spazio per i file dell'azienda è pieno (${readableSize(limit)}): elimina i file che non servono più, poi riprova.`
    throw new ApiError(413, message, 'storage_full')
  }
}

/**
 * Makes room for a new file of `bytes`, before it is written: lockStorage, then
 * checkStorage. A file that replaces another is checked after the old one is deleted.
 */
export async function reserveStorage(client: PoolClient, limit: number, bytes: number) {
  await lockStorage(client)
  await checkStorage(client, limit, bytes)
}

/** 20 GB, 512 MB, 300 KB: binary units, as the limit is given, with an Italian comma. */
export function readableSize(bytes: number): string {
  const units: [string, number][] = [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
    ['KB', 1024],
  ]
  for (const [unit, size] of units) {
    if (bytes >= size) {
      const value = Math.round((bytes / size) * 10) / 10
      return `${String(value).replace('.', ',')} ${unit}`
    }
  }
  return `${bytes} byte`
}
