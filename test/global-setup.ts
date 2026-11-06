/**
 * Creates a throwaway database next to the development one, migrates it, and hands its
 * connection strings to the tests. The development database is never touched.
 */
import { existsSync } from 'node:fs'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { migrate } from '../scripts/migrate.js'

const TEST_DB = 'gestionale_test'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}: copy .env.example to .env (or set it in CI)`)
  return value
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

export default async function setup(project: TestProject) {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const ownerUrl = required('DATABASE_URL_OWNER')

  const admin = new pg.Client({ connectionString: ownerUrl })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${TEST_DB} with (force)`)
    await admin.query(`create database ${TEST_DB}`)
  } finally {
    await admin.end()
  }

  const urls = {
    owner: withDatabase(ownerUrl, TEST_DB),
    app: withDatabase(required('DATABASE_URL_APP'), TEST_DB),
    auth: withDatabase(required('DATABASE_URL_AUTH'), TEST_DB),
  }
  await migrate({
    ownerUrl: urls.owner,
    appPassword: required('DB_APP_PASSWORD'),
    authPassword: required('DB_AUTH_PASSWORD'),
  })
  project.provide('testDb', urls)
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDb: { owner: string; app: string; auth: string }
  }
}
