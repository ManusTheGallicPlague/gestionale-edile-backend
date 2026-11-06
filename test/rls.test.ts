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

  it('deadlines: cannot read, write or link across companies', async () => {
    const clientB = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyB.id],
    )
    await owner.query(
      "insert into public.deadlines (company_id, title, due_on, kind) values ($1, 'B', '2026-12-01', 'tax')",
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.deadlines where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.deadlines (company_id, title, due_on, kind) values ($1, 'X', '2026-12-01', 'tax')",
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // My company, their client: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.deadlines (company_id, title, due_on, kind, client_id) values ($1, 'X', '2026-12-01', 'tax', $2)",
          [companyA.id, clientB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // A deadline of mine cannot point to theirs as its next one.
    const theirs = await owner.query<{ id: string }>(
      'select id from public.deadlines where company_id = $1 limit 1',
      [companyB.id],
    )
    await expect(
      as(alice.id, companyA.id, async (c) => {
        const mine = await c.query<{ id: string }>(
          "insert into public.deadlines (company_id, title, due_on, kind) values ($1, 'A', '2026-12-01', 'tax') returning id",
          [companyA.id],
        )
        return c.query('update public.deadlines set next_deadline_id = $1 where id = $2', [
          theirs.rows[0]?.id,
          mine.rows[0]?.id,
        ])
      }),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.deadlines set title = 'preso'")
      const d = await c.query('delete from public.deadlines')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.deadlines')).rejects.toThrow(/permission denied/)
  })

  it('estimates: cannot read, write or link a client across companies', async () => {
    const clientB = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyB.id],
    )
    await owner.query("insert into public.estimates (company_id, title) values ($1, 'B')", [
      companyB.id,
    ])
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.estimates where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.estimates (company_id, title) values ($1, 'X')", [companyB.id]),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.estimates (company_id, title, client_id) values ($1, 'X', $2)",
          [companyA.id, clientB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.estimates set title = 'preso'")
      const d = await c.query('delete from public.estimates')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.estimates')).rejects.toThrow(/permission denied/)
  })

  it('sites: cannot read, write or link a client across companies', async () => {
    const clientB = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyB.id],
    )
    await owner.query("insert into public.sites (company_id, name) values ($1, 'B')", [companyB.id])
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.sites where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.sites (company_id, name) values ($1, 'X')", [companyB.id]),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.sites (company_id, name, client_id) values ($1, 'X', $2)", [
          companyA.id,
          clientB.rows[0]?.id,
        ]),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.sites set name = 'preso' where company_id = $1", [
        companyB.id,
      ])
      const d = await c.query('delete from public.sites where company_id = $1', [companyB.id])
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.sites')).rejects.toThrow(/permission denied/)
  })

  it('employees: cannot read or write across companies', async () => {
    await owner.query(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'B', 'B')",
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.employees where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.employees (company_id, first_name, last_name) values ($1, 'X', 'X')",
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query(
        'update public.employees set hourly_cost_cents = 1 where company_id = $1',
        [companyB.id],
      )
      const d = await c.query('delete from public.employees where company_id = $1', [companyB.id])
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.employees')).rejects.toThrow(/permission denied/)
  })

  it('vehicles: cannot read or write across companies', async () => {
    await owner.query(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'B', 'vehicle')",
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.vehicles where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.vehicles (company_id, name, kind) values ($1, 'X', 'vehicle')",
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.vehicles set name = 'preso' where company_id = $1", [
        companyB.id,
      ])
      const d = await c.query('delete from public.vehicles where company_id = $1', [companyB.id])
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.vehicles')).rejects.toThrow(/permission denied/)
  })

  it('estimate chapters and items: cannot read, write or attach across companies', async () => {
    const estimateB = await owner.query<{ id: string }>(
      "insert into public.estimates (company_id, title) values ($1, 'B') returning id",
      [companyB.id],
    )
    const chapterB = await owner.query<{ id: string }>(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Capitolo B', 0) returning id`,
      [companyB.id, estimateB.rows[0]?.id],
    )
    await owner.query(
      `insert into public.estimate_items
         (company_id, estimate_id, chapter_id, description, unit, unit_price_cents, position)
       values ($1, $2, $3, 'Voce B', 'm²', 1000, 0)`,
      [companyB.id, estimateB.rows[0]?.id, chapterB.rows[0]?.id],
    )
    const estimateA = await as(alice.id, companyA.id, (c) =>
      c.query<{ id: string }>(
        "insert into public.estimates (company_id, title) values ($1, 'A') returning id",
        [companyA.id],
      ),
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const ch = await c.query('select * from public.estimate_chapters where company_id = $1', [
        companyB.id,
      ])
      const it = await c.query('select * from public.estimate_items where company_id = $1', [
        companyB.id,
      ])
      return (ch.rowCount ?? 0) + (it.rowCount ?? 0)
    })
    expect(seen).toBe(0)
    // Writing into company B is refused by the policy.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.estimate_chapters (company_id, estimate_id, title, position)
           values ($1, $2, 'X', 0)`,
          [companyB.id, estimateB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A chapter of company A under B's estimate or B's chapter: the foreign keys refuse it.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.estimate_chapters (company_id, estimate_id, title, position)
           values ($1, $2, 'X', 0)`,
          [companyA.id, estimateB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.estimate_items
             (company_id, estimate_id, chapter_id, description, unit, unit_price_cents, position)
           values ($1, $2, $3, 'X', 'm', 0, 0)`,
          [companyA.id, estimateA.rows[0]?.id, chapterB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u1 = await c.query("update public.estimate_chapters set title = 'preso'")
      const u2 = await c.query("update public.estimate_items set description = 'preso'")
      const d1 = await c.query('delete from public.estimate_items')
      const d2 = await c.query('delete from public.estimate_chapters')
      return [u1, u2, d1, d2].reduce((n, r) => n + (r.rowCount ?? 0), 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.estimate_chapters')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.estimate_items')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('estimate measurements: cannot read, write or attach across companies', async () => {
    const estimateB = await owner.query<{ id: string }>(
      "insert into public.estimates (company_id, title) values ($1, 'B misure') returning id",
      [companyB.id],
    )
    const chapterB = await owner.query<{ id: string }>(
      `insert into public.estimate_chapters (company_id, estimate_id, title, position)
       values ($1, $2, 'Capitolo B', 0) returning id`,
      [companyB.id, estimateB.rows[0]?.id],
    )
    const itemB = await owner.query<{ id: string }>(
      `insert into public.estimate_items
         (company_id, estimate_id, chapter_id, description, unit, unit_price_cents, position)
       values ($1, $2, $3, 'Voce B', 'm²', 1000, 0) returning id`,
      [companyB.id, estimateB.rows[0]?.id, chapterB.rows[0]?.id],
    )
    await owner.query(
      `insert into public.estimate_measurements (company_id, estimate_id, item_id, length, position)
       values ($1, $2, $3, 5, 0)`,
      [companyB.id, estimateB.rows[0]?.id, itemB.rows[0]?.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.estimate_measurements where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // The totals view runs with the caller's rights: company B's totals stay invisible.
    const totals = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.estimate_item_totals where estimate_id = $1', [
        estimateB.rows[0]?.id,
      ]),
    )
    expect(totals.rowCount).toBe(0)
    const ownerSees = await owner.query(
      'select amount_cents::text as cents from public.estimate_item_totals where estimate_id = $1',
      [estimateB.rows[0]?.id],
    )
    expect(ownerSees.rows).toEqual([{ cents: '5000' }])
    await expect(auth.query('select * from public.estimate_item_totals')).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.estimate_measurements
             (company_id, estimate_id, item_id, length, position) values ($1, $2, $3, 1, 0)`,
          [companyB.id, estimateB.rows[0]?.id, itemB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.estimate_measurements
             (company_id, estimate_id, item_id, length, position) values ($1, $2, $3, 1, 0)`,
          [companyA.id, estimateB.rows[0]?.id, itemB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query('update public.estimate_measurements set length = 99')
      const d = await c.query('delete from public.estimate_measurements')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.estimate_measurements')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('quotes and their counters: cannot read, write or link across companies', async () => {
    const clientB = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyB.id],
    )
    const clientA = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyA.id],
    )
    await owner.query(
      "insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'B')",
      [companyB.id, clientB.rows[0]?.id],
    )
    await owner.query(
      'insert into public.quote_counters (company_id, year, last_number) values ($1, 2026, 7)',
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const q = await c.query('select * from public.quotes where company_id = $1', [companyB.id])
      const k = await c.query('select * from public.quote_counters where company_id = $1', [
        companyB.id,
      ])
      return (q.rowCount ?? 0) + (k.rowCount ?? 0)
    })
    expect(seen).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'X')", [
          companyB.id,
          clientB.rows[0]?.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'X')", [
          companyA.id,
          clientB.rows[0]?.id,
        ]),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          'insert into public.quote_counters (company_id, year, last_number) values ($1, 2027, 0)',
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.quotes set subject = 'preso'")
      const d = await c.query('delete from public.quotes')
      const k = await c.query('update public.quote_counters set last_number = 0')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0) + (k.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    // A revision cannot point at another company's quote.
    const quoteB = await owner.query<{ id: string }>(
      'select id from public.quotes where company_id = $1 limit 1',
      [companyB.id],
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.quotes (company_id, client_id, subject, revision_of_id) values ($1, $2, 'X', $3)",
          [companyA.id, clientA.rows[0]?.id, quoteB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // Counters are never deleted: that would reuse numbers.
    await expect(
      as(alice.id, companyA.id, (c) => c.query('delete from public.quote_counters')),
    ).rejects.toThrow(/permission denied/)
    expect(clientA.rowCount).toBe(1)
    await expect(auth.query('select * from public.quotes')).rejects.toThrow(/permission denied/)
  })

  it('company profiles: cannot read or write another company’s', async () => {
    await owner.query(
      "insert into public.company_profiles (company_id, legal_name) values ($1, 'B S.r.l.') on conflict do nothing",
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.company_profiles where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.company_profiles (company_id, legal_name) values ($1, 'preso')",
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, (c) =>
      c.query("update public.company_profiles set legal_name = 'preso'"),
    )
    expect(changed.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) => c.query('delete from public.company_profiles')),
    ).rejects.toThrow(/permission denied/)
    const still = await owner.query<{ legal_name: string }>(
      'select legal_name from public.company_profiles where company_id = $1',
      [companyB.id],
    )
    expect(still.rows[0]?.legal_name).toBe('B S.r.l.')
  })

  it('company logos: cannot read, replace or delete another company’s', async () => {
    await owner.query(
      "insert into public.company_logos (company_id, content_type, data) values ($1, 'image/png', '\\x01') on conflict do nothing",
      [companyB.id],
    )
    const touched = await as(alice.id, companyA.id, async (c) => {
      const r = await c.query('select * from public.company_logos where company_id = $1', [
        companyB.id,
      ])
      const u = await c.query("update public.company_logos set data = '\\x02'")
      const d = await c.query('delete from public.company_logos')
      return (r.rowCount ?? 0) + (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(touched).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.company_logos (company_id, content_type, data) values ($1, 'image/png', '\\x03')",
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const still = await owner.query<{ data: Buffer }>(
      'select data from public.company_logos where company_id = $1',
      [companyB.id],
    )
    expect([...(still.rows[0]?.data ?? [])]).toEqual([1])
  })

  it('invitations: cannot read, create, delete or read the token hash across companies', async () => {
    const roleB = await fx.role(companyB.id, `Invito B ${Math.random()}`, [])
    const hash = 'b'.repeat(63) + String(Math.floor(Math.random() * 10))
    await owner.query(
      `insert into public.invitations (company_id, email, role_id, token_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 day')`,
      [companyB.id, `b-${hash.slice(-6)}@example.test`, roleB, hash],
    )
    const touched = await as(alice.id, companyA.id, async (c) => {
      const r = await c.query('select id, email from public.invitations where company_id = $1', [
        companyB.id,
      ])
      const d = await c.query('delete from public.invitations where company_id = $1', [companyB.id])
      return (r.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(touched).toBe(0)
    // Not even the own company's token hashes are readable, nor can a row be changed.
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select token_hash from public.invitations')),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("update public.invitations set expires_at = now() + interval '1 year'"),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invitations (company_id, email, role_id, token_hash, expires_at)
           values ($1, 'x@example.test', $2, $3, now())`,
          [companyB.id, roleB, 'c'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // Own company, but a role of the other one: the composite key refuses it.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invitations (company_id, email, role_id, token_hash, expires_at)
           values ($1, 'y@example.test', $2, $3, now())`,
          [companyA.id, roleB, 'd'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/foreign key|permission denied/)
    // The API role cannot call the token functions, which run without an identity.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('select * from auth.invitation_by_token($1)', [hash]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('select * from auth.accept_invitation($1, null, null, null)', [hash]),
      ),
    ).rejects.toThrow(/permission denied/)
    // Membership of the other company is not revealed.
    const bob = await fx.user()
    await fx.member(bob.id, companyB.id, roleB)
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query<{ m: boolean }>('select app.is_company_member($1) as m', [bob.email]),
    )
    expect(seen.rows[0]?.m).toBe(false)
  })

  it('members: cannot change or deactivate members of another company', async () => {
    const roleB = await fx.role(companyB.id, `Membri B ${Math.random()}`, ['users.manage'])
    const carol = await fx.user()
    await fx.member(carol.id, companyB.id, roleB)
    const changed = await as(alice.id, companyA.id, (c) =>
      c.query<{ f: boolean }>('select app.update_company_member($1, null, false) as f', [carol.id]),
    )
    expect(changed.rows[0]?.f).toBe(false)
    // Declaring a company the user does not belong to does not help either.
    const declared = await as(alice.id, companyB.id, (c) =>
      c.query<{ f: boolean }>('select app.update_company_member($1, null, false) as f', [carol.id]),
    )
    expect(declared.rows[0]?.f).toBe(false)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('update public.memberships set disabled_at = now() where user_id = $1', [carol.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    const still = await owner.query<{ disabled_at: Date | null }>(
      'select disabled_at from public.memberships where user_id = $1',
      [carol.id],
    )
    expect(still.rows[0]?.disabled_at).toBeNull()
    // A deactivated member loses the company in every identity helper.
    await owner.query('update public.memberships set disabled_at = now() where user_id = $1', [
      carol.id,
    ])
    const seen = await as(carol.id, companyB.id, async (c) => {
      const company = await c.query<{ id: string | null }>('select app.current_company_id() as id')
      const mine = await c.query('select * from app.my_company_ids()')
      const own = await c.query('select * from public.memberships')
      const clients = await c.query('select * from public.clients')
      return [company.rows[0]?.id ?? null, mine.rowCount, own.rowCount, clients.rowCount]
    })
    expect(seen).toEqual([null, 0, 0, 0])
  })

  it('roles: cannot create, rename, delete or grant permissions across companies', async () => {
    const roleB = await fx.role(companyB.id, `Ruoli B ${Math.random()}`, [])
    const touched = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.roles set name = 'Preso' where id = $1", [roleB])
      const d = await c.query('delete from public.roles where id = $1', [roleB])
      const p = await c.query('delete from public.role_permissions where role_id = $1', [roleB])
      return (u.rowCount ?? 0) + (d.rowCount ?? 0) + (p.rowCount ?? 0)
    })
    expect(touched).toBe(0)
    for (const sql of [
      ["insert into public.roles (company_id, name) values ($1, 'Intruso')", [companyB.id]],
      ["insert into public.role_permissions values ($1, 'users.manage')", [roleB]],
    ] as const) {
      await expect(as(alice.id, companyA.id, (c) => c.query(sql[0], [...sql[1]]))).rejects.toThrow(
        /row-level security/,
      )
    }
    // Moving a role to another company is not possible either.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('update public.roles set company_id = $1', [companyB.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    const still = await owner.query('select 1 from public.role_permissions where role_id = $1', [
      roleB,
    ])
    expect(still.rowCount).toBe(0)
  })

  it('profile: the API role cannot touch names or passwords, the auth role only those', async () => {
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("update auth.users set name = 'Preso' where id = $1", [alice.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      auth.query("update auth.users set email = 'x@example.test' where false"),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('update auth.users set active = false where false')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('password resets: the API role cannot read or write them', async () => {
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select * from auth.password_resets')),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          'insert into auth.password_resets (user_id, token_hash, expires_at) values ($1, $2, now())',
          [alice.id, 'e'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/permission denied/)
    // The auth role can mark a token used, but cannot move it to another account.
    await expect(
      auth.query('update auth.password_resets set user_id = $1 where false', [alice.id]),
    ).rejects.toThrow(/permission denied/)
  })

  it('quote lines: cannot read, write or attach across companies', async () => {
    const clientB = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyB.id],
    )
    const quoteB = await owner.query<{ id: string }>(
      "insert into public.quotes (company_id, client_id, subject) values ($1, $2, 'B righe') returning id",
      [companyB.id, clientB.rows[0]?.id],
    )
    await owner.query(
      `insert into public.quote_lines (company_id, quote_id, kind, description, position)
       values ($1, $2, 'text', 'Riga B', 0)`,
      [companyB.id, quoteB.rows[0]?.id],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.quote_lines where quote_id = $1', [quoteB.rows[0]?.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.quote_lines (company_id, quote_id, kind, description, position)
           values ($1, $2, 'text', 'X', 1)`,
          [companyB.id, quoteB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.quote_lines (company_id, quote_id, kind, description, position)
           values ($1, $2, 'text', 'X', 1)`,
          [companyA.id, quoteB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.quote_lines set description = 'preso'")
      const d = await c.query('delete from public.quote_lines')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.quote_lines')).rejects.toThrow(
      /permission denied/,
    )
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

  it('company members: only of the declared company the user belongs to', async () => {
    const mine = await as(alice.id, companyA.id, (c) =>
      c.query<{ user_id: string }>('select * from app.company_members()'),
    )
    expect(mine.rows.some((r) => r.user_id === alice.id)).toBe(true)
    const bMembers = await owner.query<{ user_id: string }>(
      'select user_id from public.memberships where company_id = $1',
      [companyB.id],
    )
    const ids = new Set(mine.rows.map((r) => r.user_id))
    for (const m of bMembers.rows) {
      const alsoInA = await owner.query(
        'select 1 from public.memberships where user_id = $1 and company_id = $2',
        [m.user_id, companyA.id],
      )
      if (!alsoInA.rowCount) expect(ids.has(m.user_id)).toBe(false)
    }
    // Declaring a company the user does not belong to gives nothing.
    const theirs = await as(alice.id, companyB.id, (c) =>
      c.query('select * from app.company_members()'),
    )
    expect(theirs.rowCount).toBe(0)
    await expect(auth.query('select * from app.company_members()')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('reads only the change log of its company and cannot write it', async () => {
    // The setup inserted one client per company: each insert left a line in the log.
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query<{ company_id: string }>('select company_id from public.audit_log'),
    )
    expect(seen.rowCount).toBeGreaterThan(0)
    expect(seen.rows.every((r) => r.company_id === companyA.id)).toBe(true)
    const theirs = await as(alice.id, companyB.id, (c) => c.query('select * from public.audit_log'))
    expect(theirs.rowCount).toBe(0)
    for (const sql of [
      `insert into public.audit_log (company_id, entity, entity_id, action)
       values ('${companyA.id}', 'client', gen_random_uuid(), 'delete')`,
      "update public.audit_log set fields = '{x}'",
      'delete from public.audit_log',
    ]) {
      await expect(as(alice.id, companyA.id, (c) => c.query(sql))).rejects.toThrow(
        /permission denied/,
      )
    }
    // A change through the API role is logged with the declared user, in its company only.
    const logged = await as(alice.id, companyA.id, async (c) => {
      await c.query("update public.clients set notes = 'audit' where company_id = $1", [
        companyA.id,
      ])
      return c.query<{ user_id: string; fields: string[] }>(
        "select user_id, fields from public.audit_log where action = 'update'",
      )
    })
    expect(logged.rows).toEqual([{ user_id: alice.id, fields: ['notes'] }])
    // Names come only for users in the declared company's log.
    const bob = await fx.user({ name: 'Bob di B' })
    await owner.query(
      `insert into public.audit_log (company_id, entity, entity_id, action, user_id)
       values ($1, 'client', gen_random_uuid(), 'create', $2)`,
      [companyB.id, bob.id],
    )
    const names = await as(alice.id, companyA.id, (c) =>
      c.query('select * from app.audit_users($1)', [[bob.id, alice.id]]),
    )
    expect(names.rows.map((r: { name: string }) => r.name)).not.toContain('Bob di B')
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select app.audit_row()')),
    ).rejects.toThrow(/permission denied|trigger/)
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
