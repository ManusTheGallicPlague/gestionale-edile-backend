/**
 * Adversarial: talks to Postgres directly as the API role and tries to cross companies.
 * Every case here must FAIL to reach someone else's data. Keep it green forever: it is the
 * guarantee that a bug in the API code does not become a leak between companies.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inject } from 'vitest'
import { Fixtures } from './helpers.js'

let owner: pg.Pool
let app: pg.Pool
let auth: pg.Pool
let fx: Fixtures
let alice: { id: string }
let companyA: { id: string }
let companyB: { id: string }

async function as<T>(userId: string, companyId: string, fn: (c: pg.PoolClient) => Promise<T>) {
  const client = await app.connect()
  try {
    await client.query('begin')
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.company_id', $2, true)",
      [userId, companyId],
    )
    return await fn(client)
  } finally {
    await client.query('rollback')
    client.release()
  }
}

beforeAll(async () => {
  const urls = inject('testDb')
  owner = new pg.Pool({ connectionString: urls.owner })
  app = new pg.Pool({ connectionString: urls.app })
  auth = new pg.Pool({ connectionString: urls.auth })
  fx = new Fixtures(owner)
  const a = await fx.companyWithUser(['clients.view', 'clients.create', 'clients.update'])
  alice = a.user
  companyA = a.company
  companyB = await fx.company()
  for (const [companyId, vat] of [
    [companyA.id, '11111111115'],
    [companyB.id, '22222222220'],
  ] as const) {
    await owner.query(
      "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'C', $2)",
      [companyId, vat],
    )
  }
})

afterAll(async () => {
  await Promise.all([owner.end(), app.end(), auth.end()])
})

describe('the API role cannot cross companies', () => {
  it('with no identity it sees nothing at all', async () => {
    const companies = await app.query('select * from public.companies')
    const clients = await app.query('select * from public.clients')
    expect(companies.rowCount).toBe(0)
    expect(clients.rowCount).toBe(0)
  })

  it('in its own company it sees only that company', async () => {
    const rows = await as(alice.id, companyA.id, (c) =>
      c.query('select company_id from public.clients'),
    )
    expect(rows.rows).toEqual([{ company_id: companyA.id }])
  })

  it('declaring a company it does not belong to gives nothing', async () => {
    const rows = await as(alice.id, companyB.id, (c) => c.query('select * from public.clients'))
    expect(rows.rowCount).toBe(0)
  })

  it('cannot read another company by id even without a company declared', async () => {
    const rows = await as(alice.id, '', (c) =>
      c.query('select * from public.clients where company_id = $1', [companyB.id]),
    )
    expect(rows.rowCount).toBe(0)
  })

  it('cannot insert into another company', async () => {
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.clients (company_id, kind, name) values ($1, 'person', 'X')", [
          companyB.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('cannot move a client to another company', async () => {
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('update public.clients set company_id = $1', [companyB.id]),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('cannot update or delete clients of another company', async () => {
    const updated = await as(alice.id, companyA.id, (c) =>
      c.query("update public.clients set name = 'preso' where company_id = $1", [companyB.id]),
    )
    expect(updated.rowCount).toBe(0)
    const deleted = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.clients where company_id = $1', [companyB.id]),
    )
    expect(deleted.rowCount).toBe(0)
    const archived = await as(alice.id, companyA.id, (c) =>
      c.query('update public.clients set archived_at = now() where company_id = $1', [companyB.id]),
    )
    expect(archived.rowCount).toBe(0)
    const stillThere = await owner.query('select 1 from public.clients where company_id = $1', [
      companyB.id,
    ])
    expect(stillThere.rowCount).toBe(1)
  })

  it('suppliers: sees only its own, cannot insert, move, update or delete across', async () => {
    for (const [companyId, vat] of [
      [companyA.id, '33333333336'],
      [companyB.id, '44444444442'],
    ] as const) {
      await owner.query(
        "insert into public.suppliers (company_id, name, vat_number) values ($1, 'F', $2)",
        [companyId, vat],
      )
    }
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select company_id from public.suppliers'),
    )
    expect(seen.rows).toEqual([{ company_id: companyA.id }])
    const wrongCompany = await as(alice.id, companyB.id, (c) =>
      c.query('select * from public.suppliers'),
    )
    expect(wrongCompany.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.suppliers (company_id, name) values ($1, 'X')", [companyB.id]),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('update public.suppliers set company_id = $1', [companyB.id]),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.suppliers set name = 'preso' where company_id = $1", [
        companyB.id,
      ])
      const d = await c.query('delete from public.suppliers where company_id = $1', [companyB.id])
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    const none = await app.query('select * from public.suppliers')
    expect(none.rowCount).toBe(0)
    await expect(auth.query('select * from public.suppliers')).rejects.toThrow(/permission denied/)
  })

  it('supplier documents: cannot read across, nor link to a supplier of another company', async () => {
    const suppliers = await owner.query<{ id: string; company_id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'DA'), ($2, 'DB') returning id, company_id",
      [companyA.id, companyB.id],
    )
    const supplierOf = (companyId: string) =>
      suppliers.rows.find((r) => r.company_id === companyId)?.id ?? ''
    await owner.query(
      "insert into public.supplier_documents (company_id, supplier_id, kind) values ($1, $2, 'durc')",
      [companyB.id, supplierOf(companyB.id)],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.supplier_documents where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // My company, their supplier: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.supplier_documents (company_id, supplier_id, kind) values ($1, $2, 'durc')",
          [companyA.id, supplierOf(companyB.id)],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.supplier_documents (company_id, supplier_id, kind) values ($1, $2, 'durc')",
          [companyB.id, supplierOf(companyB.id)],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.supplier_documents set notes = 'x'")
      const d = await c.query('delete from public.supplier_documents')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
  })

  it('cannot see memberships of other users', async () => {
    const other = await fx.user()
    const roleId = await fx.role(companyA.id, `Altro ${other.id.slice(0, 6)}`, [])
    await fx.member(other.id, companyA.id, roleId)
    const rows = await as(alice.id, companyA.id, (c) =>
      c.query('select user_id from public.memberships'),
    )
    expect(rows.rows.every((r: { user_id: string }) => r.user_id === alice.id)).toBe(true)
  })

  it('cannot read password hashes or sessions', async () => {
    await expect(app.query('select * from auth.users')).rejects.toThrow(/permission denied/)
    await expect(app.query('select * from auth.sessions')).rejects.toThrow(/permission denied/)
  })

  it('cannot create companies or change memberships', async () => {
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.companies (slug, name) values ('x-y-z', 'X')"),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query('delete from public.memberships')),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('the auth role reaches only sign-in data', () => {
  it('cannot read company data', async () => {
    await expect(auth.query('select * from public.clients')).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.companies')).rejects.toThrow(/permission denied/)
  })

  it('cannot change users', async () => {
    await expect(auth.query('update auth.users set active = true')).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('database rules', () => {
  it('refuses slugs reserved for the frontend routes', async () => {
    await expect(
      owner.query("insert into public.companies (slug, name) values ('accedi', 'X')"),
    ).rejects.toThrow(/check constraint/)
  })

  it('refuses a membership with a role of another company', async () => {
    const user = await fx.user()
    const roleB = await fx.role(companyB.id, 'Ruolo di B', [])
    await expect(fx.member(user.id, companyA.id, roleB)).rejects.toThrow(/foreign key/)
  })
})
