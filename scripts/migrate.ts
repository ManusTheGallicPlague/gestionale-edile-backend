/**
 * Applies db/migrations/*.sql in order, each one once and atomically.
 *
 * Runs as the owner. First it makes sure the two login roles exist with the
 * passwords from the environment, so no password ever lands in a versioned file.
 * Also exported for the test setup, which migrates a throwaway database.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

/**
 * db/migrations at the root of the project, whether this file runs from scripts/ (tsx) or
 * compiled from dist/scripts/ (production image).
 */
export function migrationsDir(scriptDir: string): string {
  const root = path.basename(path.dirname(scriptDir)) === 'dist' ? '../..' : '..'
  return path.resolve(scriptDir, root, 'db', 'migrations')
}

const MIGRATIONS = migrationsDir(path.dirname(fileURLToPath(import.meta.url)))

export interface MigrateOptions {
  ownerUrl: string
  appPassword: string
  authPassword: string
  log?: (line: string) => void
}

/** Creates or updates a login role without ever concatenating the password into SQL. */
async function ensureRole(client: pg.Client, role: string, password: string) {
  if (!/^[a-z_]+$/.test(role)) throw new Error(`Invalid role name: ${role}`)
  await client.query('select set_config($1, $2, false)', ['gestionale.tmp_password', password])
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        create role ${role} login;
      end if;
      execute format('alter role ${role} login nobypassrls password %L',
        current_setting('gestionale.tmp_password'));
    end $$;
  `)
  await client.query('select set_config($1, $2, false)', ['gestionale.tmp_password', ''])
}

export async function migrate({
  ownerUrl,
  appPassword,
  authPassword,
  log = () => {},
}: MigrateOptions) {
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    await ensureRole(client, 'gestionale_app', appPassword)
    await ensureRole(client, 'gestionale_auth', authPassword)
    log('roles: gestionale_app, gestionale_auth')

    await client.query(`
      create table if not exists public._migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `)
    await client.query('revoke all on public._migrations from public')

    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
    const { rows } = await client.query<{ name: string }>('select name from public._migrations')
    const applied = new Set(rows.map((r) => r.name))

    let count = 0
    for (const name of files) {
      if (applied.has(name)) continue
      const sql = await readFile(path.join(MIGRATIONS, name), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into public._migrations (name) values ($1)', [name])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw new Error(`${name} failed, nothing written: ${(error as Error).message}`)
      }
      log(`applied ${name}`)
      count++
    }
    log(count ? `${count} migrations applied` : 'already up to date')
  } finally {
    await client.end()
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} (see .env.example)`)
  return value
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate({
    ownerUrl: required('DATABASE_URL_OWNER'),
    appPassword: required('DB_APP_PASSWORD'),
    authPassword: required('DB_AUTH_PASSWORD'),
    log: (line) => console.log(`  ${line}`),
  }).catch((error: unknown) => {
    console.error(`✗ ${(error as Error).message}`)
    process.exit(1)
  })
}
