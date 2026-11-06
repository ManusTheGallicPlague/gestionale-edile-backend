import type pg from 'pg'
import { declareCompany } from './db.js'
import { notFound } from './http/errors.js'
import { isPermission, type Permission } from './permissions.js'

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Resolves the company in the path for the user declared in the transaction, declares it,
 * and returns the user's permissions there. A company the user does not belong to is
 * answered exactly like one that does not exist: 404.
 */
export async function enterCompany(client: pg.PoolClient, slug: string): Promise<Set<Permission>> {
  if (!SLUG.test(slug) || slug.length > 50) throw notFound()
  // Row Level Security only shows the user's own companies.
  const { rows } = await client.query<{ id: string }>(
    'select id from public.companies where slug = $1',
    [slug],
  )
  const company = rows[0]
  if (!company) throw notFound()
  await declareCompany(client, company.id)

  const { rows: granted } = await client.query<{ permission: string }>(
    `select rp.permission
     from public.memberships m
     join public.role_permissions rp on rp.role_id = m.role_id
     where m.user_id = app.current_user_id() and m.company_id = app.current_company_id()`,
  )
  return new Set(granted.map((r) => r.permission).filter(isPermission))
}
