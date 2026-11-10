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

  it('supplier document files: cannot read, write or hang a file across companies', async () => {
    const suppliers = await owner.query<{ id: string; company_id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'FA'), ($2, 'FB') returning id, company_id",
      [companyA.id, companyB.id],
    )
    const docs: Record<string, string> = {}
    for (const row of suppliers.rows) {
      const d = await owner.query<{ id: string }>(
        "insert into public.supplier_documents (company_id, supplier_id, kind) values ($1, $2, 'durc') returning id",
        [row.company_id, row.id],
      )
      docs[row.company_id] = d.rows[0]?.id ?? ''
    }
    const file = (documentId: string | undefined, companyId: string) =>
      `insert into public.supplier_document_files
         (document_id, company_id, file_name, content_type, size_bytes, data)
       values ('${documentId}', '${companyId}', 'durc.pdf', 'application/pdf', 1, '\\x25')`
    await owner.query(file(docs[companyB.id], companyB.id))
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.supplier_document_files where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // A file of company A on a document of company B: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyA.id))),
    ).rejects.toThrow(/foreign key|duplicate key/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyB.id))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.supplier_document_files where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    // The bytes are never changed in place, not even in one's own company.
    await expect(
      as(alice.id, companyA.id, async (c) => {
        await c.query(file(docs[companyA.id], companyA.id))
        return c.query("update public.supplier_document_files set data = '\\x26'")
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.supplier_document_files')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('invoice files: cannot read, write or hang a file across companies', async () => {
    const ids: Record<string, string> = {}
    for (const companyId of [companyA.id, companyB.id]) {
      const r = await owner.query<{ id: string }>(
        `insert into public.invoices (company_id, direction, number, invoice_date, client_id, taxable_cents, vat_cents)
         select $1, 'issued', 'RLS-1', '2026-11-02', c.id, 100, 22
         from public.clients c where c.company_id = $1 limit 1 returning id`,
        [companyId],
      )
      ids[companyId] = r.rows[0]?.id ?? ''
    }
    const file = (invoiceId: string | undefined, companyId: string) =>
      `insert into public.invoice_files
         (invoice_id, company_id, file_name, content_type, size_bytes, data)
       values ('${invoiceId}', '${companyId}', 'f.pdf', 'application/pdf', 1, '\\x25')`
    await owner.query(file(ids[companyB.id], companyB.id))
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.invoice_files where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(ids[companyB.id], companyA.id))),
    ).rejects.toThrow(/foreign key|duplicate key/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(ids[companyB.id], companyB.id))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.invoice_files where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, async (c) => {
        await c.query(file(ids[companyA.id], companyA.id))
        return c.query("update public.invoice_files set data = '\\x26'")
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.invoice_files')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('invoice payments: cannot read, write or hang a payment across companies', async () => {
    const ids: Record<string, string> = {}
    for (const companyId of [companyA.id, companyB.id]) {
      const r = await owner.query<{ id: string }>(
        `insert into public.invoices (company_id, direction, number, invoice_date, client_id, taxable_cents, vat_cents)
         select $1, 'issued', 'RLS-P', '2026-11-02', c.id, 100, 22
         from public.clients c where c.company_id = $1 limit 1 returning id`,
        [companyId],
      )
      ids[companyId] = r.rows[0]?.id ?? ''
    }
    const payment = (invoiceId: string | undefined, companyId: string) =>
      `insert into public.invoice_payments (invoice_id, company_id, payment_date, amount_cents)
       values ('${invoiceId}', '${companyId}', '2026-11-03', 50)`
    await owner.query(payment(ids[companyB.id], companyB.id))
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.invoice_payments where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // A payment of company A on an invoice of company B: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) => c.query(payment(ids[companyB.id], companyA.id))),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(payment(ids[companyB.id], companyB.id))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.invoice_payments where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    // A payment is never changed in place, not even in one's own company.
    await expect(
      as(alice.id, companyA.id, async (c) => {
        await c.query(payment(ids[companyA.id], companyA.id))
        return c.query('update public.invoice_payments set amount_cents = 1')
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.invoice_payments')).rejects.toThrow(
      /permission denied/,
    )
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

  it('deadlines: cannot link a site, employee or vehicle of another company', async () => {
    const site = await owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'B') returning id",
      [companyB.id],
    )
    const employee = await owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'B', 'B') returning id",
      [companyB.id],
    )
    const vehicle = await owner.query<{ id: string }>(
      "insert into public.vehicles (company_id, name, kind) values ($1, 'B', 'vehicle') returning id",
      [companyB.id],
    )
    for (const [column, id] of [
      ['site_id', site.rows[0]?.id],
      ['employee_id', employee.rows[0]?.id],
      ['vehicle_id', vehicle.rows[0]?.id],
    ] as const) {
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(
            `insert into public.deadlines (company_id, title, due_on, kind, ${column})
             values ($1, 'X', '2026-12-01', 'other', $2)`,
            [companyA.id, id],
          ),
        ),
      ).rejects.toThrow(/foreign key/)
      // Their deadline pointing to their own vehicle is still invisible and untouchable.
      await owner.query(
        `insert into public.deadlines (company_id, title, due_on, kind, ${column})
         values ($1, 'B', '2026-12-01', 'other', $2)`,
        [companyB.id, id],
      )
      const seen = await as(alice.id, companyA.id, (c) =>
        c.query(`select 1 from public.deadlines where ${column} = $1`, [id]),
      )
      expect(seen.rowCount).toBe(0)
      const changed = await as(alice.id, companyA.id, async (c) => {
        const u = await c.query(
          `update public.deadlines set ${column} = null where ${column} = $1`,
          [id],
        )
        return u.rowCount ?? 0
      })
      expect(changed).toBe(0)
    }
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
      const m = await c.query(
        'update public.sites set latitude = 1, longitude = 1 where company_id = $1',
        [companyB.id],
      )
      const d = await c.query('delete from public.sites where company_id = $1', [companyB.id])
      return (u.rowCount ?? 0) + (m.rowCount ?? 0) + (d.rowCount ?? 0)
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

  it('employee absences: cannot read or write across companies', async () => {
    const { rows } = await owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'B', 'B') returning id",
      [companyB.id],
    )
    const employeeB = rows[0]?.id
    await owner.query(
      `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
       values ($1, $2, 'vacation', '2026-08-10', '2026-08-14')`,
      [companyB.id, employeeB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.employee_absences where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
           values ($1, $2, 'vacation', '2026-09-01', '2026-09-01')`,
          [companyB.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // An absence of my company cannot point at their employee either.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on)
           values ($1, $2, 'vacation', '2026-09-01', '2026-09-01')`,
          [companyA.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.employee_absences set notes = 'x'")
      const d = await c.query('delete from public.employee_absences')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.employee_absences')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('vehicle maintenances: cannot read or write across companies', async () => {
    const vehicle = async (companyId: string) => {
      const { rows } = await owner.query<{ id: string }>(
        "insert into public.vehicles (company_id, name, kind) values ($1, 'M', 'machine') returning id",
        [companyId],
      )
      return rows[0]?.id
    }
    const vehicleB = await vehicle(companyB.id)
    const vehicleA = await vehicle(companyA.id)
    const { rows } = await owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Officina B') returning id",
      [companyB.id],
    )
    const supplierB = rows[0]?.id
    await owner.query(
      `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind, description)
       values ($1, $2, '2026-10-01', 'repair', 'B')`,
      [companyB.id, vehicleB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.vehicle_maintenances where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind, description)
           values ($1, $2, '2026-10-02', 'repair', 'X')`,
          [companyB.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A maintenance of my company cannot point at their vehicle or their workshop either.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind, description)
           values ($1, $2, '2026-10-02', 'repair', 'X')`,
          [companyA.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_maintenances
             (company_id, vehicle_id, performed_on, kind, description, supplier_id)
           values ($1, $2, '2026-10-02', 'repair', 'X', $3)`,
          [companyA.id, vehicleA, supplierB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // A deadline of my company cannot point at their maintenance as its next job.
    const { rows: jobs } = await owner.query<{ id: string }>(
      'select id from public.vehicle_maintenances where company_id = $1 limit 1',
      [companyB.id],
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.deadlines (company_id, title, due_on, kind, vehicle_maintenance_id)
           values ($1, 'X', '2027-01-01', 'vehicle', $2)`,
          [companyA.id, jobs[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.vehicle_maintenances set notes = 'x'")
      const d = await c.query('delete from public.vehicle_maintenances')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.vehicle_maintenances')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('vehicle documents: cannot read or write across companies', async () => {
    const vehicle = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.vehicles (company_id, name, kind) values ($1, 'D', 'vehicle') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const vehicleB = await vehicle(companyB.id)
    const { rows: docs } = await owner.query<{ id: string }>(
      `insert into public.vehicle_documents (company_id, vehicle_id, kind, expires_on)
       values ($1, $2, 'insurance', '2027-01-01') returning id`,
      [companyB.id, vehicleB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.vehicle_documents where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_documents (company_id, vehicle_id, kind)
           values ($1, $2, 'road_tax')`,
          [companyB.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A document of my company cannot point at their vehicle.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_documents (company_id, vehicle_id, kind)
           values ($1, $2, 'road_tax')`,
          [companyA.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // A deadline of my company cannot point at their document.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.deadlines (company_id, title, due_on, kind, vehicle_document_id)
           values ($1, 'X', '2027-01-01', 'vehicle', $2)`,
          [companyA.id, docs[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.vehicle_documents set notes = 'x'")
      const d = await c.query('delete from public.vehicle_documents')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.vehicle_documents')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('employee documents: cannot read or write across companies', async () => {
    const employee = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.employees (company_id, first_name, last_name) values ($1, 'D', 'E') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const employeeB = await employee(companyB.id)
    const { rows: docs } = await owner.query<{ id: string }>(
      `insert into public.employee_documents (company_id, employee_id, kind, expires_on)
       values ($1, $2, 'medical_check', '2027-01-01') returning id`,
      [companyB.id, employeeB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.employee_documents where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_documents (company_id, employee_id, kind)
           values ($1, $2, 'first_aid')`,
          [companyB.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A document of my company cannot point at their employee.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_documents (company_id, employee_id, kind)
           values ($1, $2, 'first_aid')`,
          [companyA.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // A deadline of my company cannot point at their document.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.deadlines (company_id, title, due_on, kind, employee_document_id)
           values ($1, 'X', '2027-01-01', 'medical_check', $2)`,
          [companyA.id, docs[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.employee_documents set notes = 'x'")
      const d = await c.query('delete from public.employee_documents')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.employee_documents')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('vehicle document files: cannot read, write or hang a file across companies', async () => {
    const docs: Record<string, string> = {}
    for (const companyId of [companyA.id, companyB.id]) {
      const v = await owner.query<{ id: string }>(
        "insert into public.vehicles (company_id, name, kind) values ($1, 'F', 'vehicle') returning id",
        [companyId],
      )
      const d = await owner.query<{ id: string }>(
        `insert into public.vehicle_documents (company_id, vehicle_id, kind)
         values ($1, $2, 'registration') returning id`,
        [companyId, v.rows[0]?.id],
      )
      docs[companyId] = d.rows[0]?.id ?? ''
    }
    const file = (documentId: string | undefined, companyId: string) =>
      `insert into public.vehicle_document_files
         (document_id, company_id, file_name, content_type, size_bytes, data)
       values ('${documentId}', '${companyId}', 'libretto.pdf', 'application/pdf', 1, '\\x25')`
    await owner.query(file(docs[companyB.id], companyB.id))
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.vehicle_document_files where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // A file of company A on a document of company B: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyA.id))),
    ).rejects.toThrow(/foreign key|duplicate key/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyB.id))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.vehicle_document_files where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    // The bytes are never changed in place, not even in one's own company.
    await expect(
      as(alice.id, companyA.id, async (c) => {
        await c.query(file(docs[companyA.id], companyA.id))
        return c.query("update public.vehicle_document_files set data = '\\x26'")
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.vehicle_document_files')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('employee document files: cannot read, write or hang a file across companies', async () => {
    const docs: Record<string, string> = {}
    for (const companyId of [companyA.id, companyB.id]) {
      const v = await owner.query<{ id: string }>(
        "insert into public.employees (company_id, first_name, last_name) values ($1, 'M', 'R') returning id",
        [companyId],
      )
      const d = await owner.query<{ id: string }>(
        `insert into public.employee_documents (company_id, employee_id, kind)
         values ($1, $2, 'medical_check') returning id`,
        [companyId, v.rows[0]?.id],
      )
      docs[companyId] = d.rows[0]?.id ?? ''
    }
    const file = (documentId: string | undefined, companyId: string) =>
      `insert into public.employee_document_files
         (document_id, company_id, file_name, content_type, size_bytes, data)
       values ('${documentId}', '${companyId}', 'idoneita.pdf', 'application/pdf', 1, '\\x25')`
    await owner.query(file(docs[companyB.id], companyB.id))
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.employee_document_files where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    // A file of company A on a document of company B: the composite foreign key says no.
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyA.id))),
    ).rejects.toThrow(/foreign key|duplicate key/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(file(docs[companyB.id], companyB.id))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.employee_document_files where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    // The bytes are never changed in place, not even in one's own company.
    await expect(
      as(alice.id, companyA.id, async (c) => {
        await c.query(file(docs[companyA.id], companyA.id))
        return c.query("update public.employee_document_files set data = '\\x26'")
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.employee_document_files')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('vehicle refuelings: cannot read or write across companies', async () => {
    const vehicle = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.vehicles (company_id, name, kind) values ($1, 'F', 'vehicle') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const vehicleA = await vehicle(companyA.id)
    const vehicleB = await vehicle(companyB.id)
    const { rows } = await owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Distributore B') returning id",
      [companyB.id],
    )
    const supplierB = rows[0]?.id
    await owner.query(
      `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
       values ($1, $2, '2026-10-01', 40, 7000)`,
      [companyB.id, vehicleB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.vehicle_refuelings where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
           values ($1, $2, '2026-10-02', 10, 100)`,
          [companyB.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A refueling of my company cannot point at their vehicle or their filling station either.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters, amount_cents)
           values ($1, $2, '2026-10-02', 10, 100)`,
          [companyA.id, vehicleB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.vehicle_refuelings
             (company_id, vehicle_id, refueled_on, liters, amount_cents, supplier_id)
           values ($1, $2, '2026-10-02', 10, 100, $3)`,
          [companyA.id, vehicleA, supplierB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.vehicle_refuelings set notes = 'x'")
      const d = await c.query('delete from public.vehicle_refuelings')
      return (u.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.vehicle_refuelings')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('employee leave carry-overs: cannot read or write across companies', async () => {
    const { rows } = await owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'C', 'C') returning id",
      [companyB.id],
    )
    const employeeB = rows[0]?.id
    await owner.query(
      `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
       values ($1, $2, 2026, 5)`,
      [companyB.id, employeeB],
    )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.employee_leave_carryovers where company_id = $1', [
        companyB.id,
      ]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
           values ($1, $2, 2027, 1)`,
          [companyB.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A carry-over of my company cannot point at their employee either.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.employee_leave_carryovers (company_id, employee_id, year, days)
           values ($1, $2, 2027, 1)`,
          [companyA.id, employeeB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query('update public.employee_leave_carryovers set days = 0')
      const h = await c.query('update public.employee_leave_carryovers set permit_hours = 99')
      const d = await c.query('delete from public.employee_leave_carryovers')
      return (u.rowCount ?? 0) + (h.rowCount ?? 0) + (d.rowCount ?? 0)
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.employee_leave_carryovers')).rejects.toThrow(
      /permission denied/,
    )
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

  it('site team: cannot read, write or attach across companies', async () => {
    const siteB = await owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'B') returning id",
      [companyB.id],
    )
    const employeeB = await owner.query<{ id: string }>(
      "insert into public.employees (company_id, first_name, last_name) values ($1, 'B', 'B') returning id",
      [companyB.id],
    )
    const siteA = await owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'A') returning id",
      [companyA.id],
    )
    await owner.query(
      'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
      [companyB.id, siteB.rows[0]?.id, employeeB.rows[0]?.id],
    )
    const seen = await as(alice.id, companyA.id, (c) => c.query('select * from public.site_team'))
    expect(seen.rows.filter((r: { company_id: string }) => r.company_id === companyB.id)).toEqual(
      [],
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
          [companyB.id, siteB.rows[0]?.id, employeeB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          'insert into public.site_team (company_id, site_id, employee_id) values ($1, $2, $3)',
          [companyA.id, siteA.rows[0]?.id, employeeB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const removed = await as(alice.id, companyA.id, (c) =>
      c.query('delete from public.site_team where company_id = $1', [companyB.id]),
    )
    expect(removed.rowCount).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) => c.query('update public.site_team set created_at = now()')),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.site_team')).rejects.toThrow(/permission denied/)
  })

  it('daily reports and their hours: cannot read, write or attach across companies', async () => {
    const make = async (companyId: string, label: string) => {
      const site = await owner.query<{ id: string }>(
        'insert into public.sites (company_id, name) values ($1, $2) returning id',
        [companyId, `Cantiere ${label}`],
      )
      const employee = await owner.query<{ id: string }>(
        `insert into public.employees (company_id, first_name, last_name)
         values ($1, 'Rapportino', $2) returning id`,
        [companyId, label],
      )
      const vehicle = await owner.query<{ id: string }>(
        `insert into public.vehicles (company_id, name, kind) values ($1, $2, 'vehicle')
         returning id`,
        [companyId, `Furgone ${label}`],
      )
      return {
        site: site.rows[0]?.id,
        employee: employee.rows[0]?.id,
        vehicle: vehicle.rows[0]?.id,
      }
    }
    const a = await make(companyA.id, 'A')
    const b = await make(companyB.id, 'B')
    const reportB = await owner.query<{ id: string }>(
      `insert into public.daily_reports (company_id, site_id, report_date)
       values ($1, $2, '2026-11-02') returning id`,
      [companyB.id, b.site],
    )
    await owner.query(
      `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
       values ($1, $2, $3, 8, 0)`,
      [companyB.id, reportB.rows[0]?.id, b.employee],
    )
    await owner.query(
      `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
       values ($1, $2, $3, 2, 0)`,
      [companyB.id, reportB.rows[0]?.id, b.vehicle],
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const r = await c.query('select * from public.daily_reports where company_id = $1', [
        companyB.id,
      ])
      const l = await c.query('select * from public.daily_report_labor where company_id = $1', [
        companyB.id,
      ])
      const v = await c.query('select * from public.daily_report_vehicles where company_id = $1', [
        companyB.id,
      ])
      return r.rowCount! + l.rowCount! + v.rowCount!
    })
    expect(seen).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.daily_reports (company_id, site_id, report_date)
           values ($1, $2, '2026-11-03')`,
          [companyB.id, b.site],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // A report of company A cannot point to a site, employee or vehicle of company B.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.daily_reports (company_id, site_id, report_date)
           values ($1, $2, '2026-11-03')`,
          [companyA.id, b.site],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const reportA = await as(alice.id, companyA.id, (c) =>
      c.query<{ id: string }>(
        `insert into public.daily_reports (company_id, site_id, report_date)
         values ($1, $2, '2026-11-03') returning id`,
        [companyA.id, a.site],
      ),
    )
    for (const [table, column, id] of [
      ['daily_report_labor', 'employee_id', b.employee],
      ['daily_report_vehicles', 'vehicle_id', b.vehicle],
    ] as const) {
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(
            `insert into public.${table} (company_id, report_id, ${column}, hours, position)
             values ($1, $2, $3, 1, 0)`,
            [companyA.id, reportA.rows[0]?.id, id],
          ),
        ),
      ).rejects.toThrow(/foreign key/)
      // Hours of company B cannot be attached to a report of company A, nor the reverse.
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(
            `insert into public.${table} (company_id, report_id, ${column}, hours, position)
             values ($1, $2, $3, 1, 0)`,
            [companyB.id, reportB.rows[0]?.id, id],
          ),
        ),
      ).rejects.toThrow(/row-level security/)
      // Hours are updated in place, only in company A and only the values: never moved.
      const updated = await as(alice.id, companyA.id, (c) =>
        c.query(`update public.${table} set hours = 1 where company_id = $1`, [companyB.id]),
      )
      expect(updated.rowCount).toBe(0)
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(`update public.${table} set report_id = $1`, [reportB.rows[0]?.id]),
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(`update public.${table} set company_id = $1`, [companyB.id]),
        ),
      ).rejects.toThrow(/permission denied/)
      // The hourly cost fixed on approval is written only by the trigger, never by the API.
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(`update public.${table} set hourly_cost_cents = 0`),
        ),
      ).rejects.toThrow(/permission denied/)
    }
    await owner.query('update public.employees set hourly_cost_cents = 2000 where id = $1', [
      b.employee,
    ])
    await owner.query('update public.vehicles set hourly_cost_cents = 1000 where id = $1', [
      b.vehicle,
    ])
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.daily_reports set status = 'approved' where id = $1", [
        reportB.rows[0]?.id,
      ])
      const d = await c.query('delete from public.daily_reports where id = $1', [
        reportB.rows[0]?.id,
      ])
      const l = await c.query('delete from public.daily_report_labor where company_id = $1', [
        companyB.id,
      ])
      return u.rowCount! + d.rowCount! + l.rowCount!
    })
    expect(changed).toBe(0)
    // Approving from company A did not reach the trigger that fixes the costs of company B.
    const fixed = await owner.query(
      `select 1 from public.daily_report_labor where report_id = $1 and hourly_cost_cents is not null
       union all
       select 1 from public.daily_report_vehicles where report_id = $1 and hourly_cost_cents is not null`,
      [reportB.rows[0]?.id],
    )
    expect(fixed.rowCount).toBe(0)
    await expect(auth.query('select * from public.daily_reports')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('site costs: cannot read, write or attach across companies', async () => {
    const siteOf = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.sites (company_id, name) values ($1, 'Costi') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const supplierB = await owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore B') returning id",
      [companyB.id],
    )
    const siteA = await siteOf(companyA.id)
    const siteB = await siteOf(companyB.id)
    const costB = await owner.query<{ id: string }>(
      `insert into public.site_costs (company_id, site_id, cost_date, category, description,
         amount_cents) values ($1, $2, '2026-11-02', 'other', 'B', 100) returning id`,
      [companyB.id, siteB],
    )
    const insert = (companyId: string, siteId: unknown, supplierId: unknown = null) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.site_costs (company_id, site_id, cost_date, category, description,
             supplier_id, amount_cents) values ($1, $2, '2026-11-02', 'other', 'A', $3, 100)`,
          [companyId, siteId, supplierId],
        ),
      )
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.site_costs where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    await expect(insert(companyB.id, siteB)).rejects.toThrow(/row-level security/)
    await expect(insert(companyA.id, siteB)).rejects.toThrow(/foreign key/)
    await expect(insert(companyA.id, siteA, supplierB.rows[0]?.id)).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query('update public.site_costs set amount_cents = 0 where id = $1', [
        costB.rows[0]?.id,
      ])
      const d = await c.query('delete from public.site_costs where id = $1', [costB.rows[0]?.id])
      return u.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.site_costs')).rejects.toThrow(/permission denied/)
  })

  it('purchase orders and their lines: cannot read, write or attach across companies', async () => {
    const supplierOf = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.suppliers (company_id, name) values ($1, 'Ordini') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const supplierA = await supplierOf(companyA.id)
    const supplierB = await supplierOf(companyB.id)
    const siteB = (
      await owner.query<{ id: string }>(
        "insert into public.sites (company_id, name) values ($1, 'Ordini B') returning id",
        [companyB.id],
      )
    ).rows[0]?.id
    const orderOf = async (companyId: string, supplierId: unknown) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
             order_date) values ($1, 2026, 900, $2, '2026-11-02') returning id`,
          [companyId, supplierId],
        )
      ).rows[0]?.id
    const orderA = await orderOf(companyA.id, supplierA)
    const orderB = await orderOf(companyB.id, supplierB)
    await owner.query(
      `insert into public.purchase_order_lines (company_id, order_id, position, description,
         quantity, unit_price_cents) values ($1, $2, 0, 'B', 1, 100)`,
      [companyB.id, orderB],
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const o = await c.query('select * from public.purchase_orders where company_id = $1', [
        companyB.id,
      ])
      const l = await c.query('select * from public.purchase_order_lines where order_id = $1', [
        orderB,
      ])
      return o.rowCount! + l.rowCount!
    })
    expect(seen).toBe(0)
    const insertOrder = (companyId: string, supplierId: unknown, siteId: unknown = null) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
             site_id, order_date) values ($1, 2026, 901, $2, $3, '2026-11-02')`,
          [companyId, supplierId, siteId],
        ),
      )
    await expect(insertOrder(companyB.id, supplierB)).rejects.toThrow(/row-level security/)
    await expect(insertOrder(companyA.id, supplierB)).rejects.toThrow(/foreign key/)
    await expect(insertOrder(companyA.id, supplierA, siteB)).rejects.toThrow(/foreign key/)
    const insertLine = (companyId: string, orderId: unknown) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.purchase_order_lines (company_id, order_id, position, description,
             quantity, unit_price_cents) values ($1, $2, 5, 'A', 1, 100)`,
          [companyId, orderId],
        ),
      )
    await expect(insertLine(companyB.id, orderB)).rejects.toThrow(/row-level security/)
    await expect(insertLine(companyA.id, orderB)).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.purchase_orders set status = 'draft' where id = $1", [
        orderB,
      ])
      const l = await c.query('delete from public.purchase_order_lines where order_id = $1', [
        orderB,
      ])
      const d = await c.query('delete from public.purchase_orders where id = $1', [orderB])
      return u.rowCount! + l.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    // Lines are updated in place, only in company A and only the values: never moved.
    const updated = await as(alice.id, companyA.id, (c) =>
      c.query('update public.purchase_order_lines set quantity = 2 where order_id = $1', [orderB]),
    )
    expect(updated.rowCount).toBe(0)
    for (const [set, value] of [
      ['order_id', orderB],
      ['company_id', companyB.id],
    ]) {
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(`update public.purchase_order_lines set ${set} = $1 where order_id = $2`, [
            value,
            orderA,
          ]),
        ),
      ).rejects.toThrow(/permission denied/)
    }
    await expect(auth.query('select * from public.purchase_orders')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.purchase_order_lines')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('purchase order counters: cannot read, write or move across companies', async () => {
    await owner.query(
      'insert into public.purchase_order_counters (company_id, year, last_number) values ($1, 2026, 40)',
      [companyB.id],
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const k = await c.query(
        'select * from public.purchase_order_counters where company_id = $1',
        [companyB.id],
      )
      return k.rowCount ?? 0
    })
    expect(seen).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          'insert into public.purchase_order_counters (company_id, year, last_number) values ($1, 2027, 0)',
          [companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const k = await c.query('update public.purchase_order_counters set last_number = 0')
      return k.rowCount ?? 0
    })
    expect(changed).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('delete from public.purchase_order_counters where company_id = $1', [companyB.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.purchase_order_counters')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('invoices: cannot read, write or attach across companies, nor link a deadline', async () => {
    const one = async (sql: string, companyId: string) =>
      (await owner.query<{ id: string }>(sql, [companyId])).rows[0]?.id
    const clientSql =
      "insert into public.clients (company_id, kind, name) values ($1, 'person', 'Fatture') returning id"
    const supplierSql =
      "insert into public.suppliers (company_id, name) values ($1, 'Fatture') returning id"
    const clientA = await one(clientSql, companyA.id)
    const clientB = await one(clientSql, companyB.id)
    const supplierB = await one(supplierSql, companyB.id)
    const siteB = await one(
      "insert into public.sites (company_id, name) values ($1, 'Fatture B') returning id",
      companyB.id,
    )
    const invoiceB = (
      await owner.query<{ id: string }>(
        `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
           taxable_cents, vat_cents) values ($1, 'issued', 'B-1', '2026-11-02', $2, 100, 22)
         returning id`,
        [companyB.id, clientB],
      )
    ).rows[0]?.id
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query('select * from public.invoices where company_id = $1', [companyB.id]),
    )
    expect(seen.rowCount).toBe(0)
    const insert = (companyId: string, clientId: unknown, extra: Record<string, unknown> = {}) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
             supplier_id, site_id, taxable_cents, vat_cents)
           values ($1, $2, 'A-1', '2026-11-02', $3, $4, $5, 100, 22)`,
          [
            companyId,
            extra.supplier ? 'received' : 'issued',
            extra.supplier ? null : clientId,
            extra.supplier ?? null,
            extra.site ?? null,
          ],
        ),
      )
    await expect(insert(companyB.id, clientB)).rejects.toThrow(/row-level security/)
    await expect(insert(companyA.id, clientB)).rejects.toThrow(/foreign key/)
    await expect(insert(companyA.id, clientA, { site: siteB })).rejects.toThrow(/foreign key/)
    await expect(insert(companyA.id, null, { supplier: supplierB })).rejects.toThrow(/foreign key/)
    // A credit note of the first company cannot credit the other company's invoice.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
             taxable_cents, vat_cents, document_type, credited_invoice_id)
           values ($1, 'issued', 'NC-1', '2026-11-03', $2, 10, 2, 'credit_note', $3)`,
          [companyA.id, clientA, invoiceB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    // A deadline of the first company cannot point to the other company's invoice.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.deadlines (company_id, title, due_on, kind, invoice_id)
           values ($1, 'X', '2026-12-01', 'invoice_out', $2)`,
          [companyA.id, invoiceB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.invoices set number = 'X' where id = $1", [invoiceB])
      const d = await c.query('delete from public.invoices where id = $1', [invoiceB])
      return u.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.invoices')).rejects.toThrow(/permission denied/)
    // Other tests change every client of the first company: leave none behind.
    await owner.query('delete from public.clients where id = $1', [clientA])
  })

  it('warehouse items and movements: cannot read, write or attach across companies', async () => {
    const itemOf = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.warehouse_items (company_id, name, unit) values ($1, 'Sabbia', 'm³') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const itemA = await itemOf(companyA.id)
    const itemB = await itemOf(companyB.id)
    const siteB = (
      await owner.query<{ id: string }>(
        "insert into public.sites (company_id, name) values ($1, 'Magazzino B') returning id",
        [companyB.id],
      )
    ).rows[0]?.id
    const movementB = (
      await owner.query<{ id: string }>(
        `insert into public.warehouse_movements (company_id, item_id, movement_date, kind, quantity)
         values ($1, $2, '2026-11-02', 'in', 5) returning id`,
        [companyB.id, itemB],
      )
    ).rows[0]?.id
    const seen = await as(alice.id, companyA.id, async (c) => {
      const i = await c.query('select * from public.warehouse_items where company_id = $1', [
        companyB.id,
      ])
      const m = await c.query('select * from public.warehouse_movements where company_id = $1', [
        companyB.id,
      ])
      return i.rowCount! + m.rowCount!
    })
    expect(seen).toBe(0)
    const insert = (companyId: string, itemId: unknown, siteId: unknown = null) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
             quantity, site_id) values ($1, $2, '2026-11-02', 'out', 1, $3)`,
          [companyId, itemId, siteId],
        ),
      )
    await expect(insert(companyB.id, itemB)).rejects.toThrow(/row-level security/)
    await expect(insert(companyA.id, itemB)).rejects.toThrow(/foreign key/)
    await expect(insert(companyA.id, itemA, siteB)).rejects.toThrow(/foreign key/)
    const supplierB = (
      await owner.query<{ id: string }>(
        "insert into public.suppliers (company_id, name) values ($1, 'Carico B') returning id",
        [companyB.id],
      )
    ).rows[0]?.id
    const orderB = (
      await owner.query<{ id: string }>(
        `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
           order_date) values ($1, 2026, 950, $2, '2026-11-02') returning id`,
        [companyB.id, supplierB],
      )
    ).rows[0]?.id
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
             quantity, purchase_order_id) values ($1, $2, '2026-11-02', 'in', 1, $3)`,
          [companyA.id, itemA, orderB],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.warehouse_items set name = 'x' where id = $1", [itemB])
      const m = await c.query('delete from public.warehouse_movements where id = $1', [movementB])
      const d = await c.query('delete from public.warehouse_items where id = $1', [itemB])
      return u.rowCount! + m.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    // Movements never change.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query('update public.warehouse_movements set quantity = 2 where item_id = $1', [itemA]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.warehouse_items')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.warehouse_movements')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('site activities and their dependencies: cannot read, write or attach across companies', async () => {
    const siteOf = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.sites (company_id, name) values ($1, 'Gantt') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const activityOf = async (companyId: string, siteId: unknown) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.site_activities (company_id, site_id, name, start_on, end_on)
           values ($1, $2, 'Scavi', '2026-11-09', '2026-11-13') returning id`,
          [companyId, siteId],
        )
      ).rows[0]?.id
    const siteA = await siteOf(companyA.id)
    const siteA2 = await siteOf(companyA.id)
    const siteB = await siteOf(companyB.id)
    const activityA = await activityOf(companyA.id, siteA)
    const activityA2 = await activityOf(companyA.id, siteA2)
    const activityB = await activityOf(companyB.id, siteB)
    const activityB2 = await activityOf(companyB.id, siteB)
    await owner.query(
      `insert into public.site_activity_dependencies (company_id, site_id, activity_id,
         depends_on_id) values ($1, $2, $3, $4)`,
      [companyB.id, siteB, activityB2, activityB],
    )
    const insert = (companyId: string, siteId: unknown) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.site_activities (company_id, site_id, name, start_on, end_on)
           values ($1, $2, 'A', '2026-11-09', '2026-11-13')`,
          [companyId, siteId],
        ),
      )
    const depend = (companyId: string, siteId: unknown, activityId: unknown, dependsOn: unknown) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.site_activity_dependencies (company_id, site_id, activity_id,
             depends_on_id) values ($1, $2, $3, $4)`,
          [companyId, siteId, activityId, dependsOn],
        ),
      )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const a = await c.query('select * from public.site_activities where company_id = $1', [
        companyB.id,
      ])
      const d = await c.query(
        'select * from public.site_activity_dependencies where company_id = $1',
        [companyB.id],
      )
      return a.rowCount! + d.rowCount!
    })
    expect(seen).toBe(0)
    await expect(insert(companyB.id, siteB)).rejects.toThrow(/row-level security/)
    await expect(insert(companyA.id, siteB)).rejects.toThrow(/foreign key/)
    await expect(depend(companyB.id, siteB, activityB, activityB2)).rejects.toThrow(
      /row-level security/,
    )
    await expect(depend(companyA.id, siteA, activityA, activityB)).rejects.toThrow(/foreign key/)
    // Both ends of a dependency stay on the same site.
    await expect(depend(companyA.id, siteA, activityA, activityA2)).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query('update public.site_activities set progress = 100 where id = $1', [
        activityB,
      ])
      const d = await c.query(
        'delete from public.site_activity_dependencies where activity_id = $1',
        [activityB2],
      )
      const a = await c.query('delete from public.site_activities where id = $1', [activityB])
      return u.rowCount! + d.rowCount! + a.rowCount!
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.site_activities')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.site_activity_dependencies')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('progress statements and their lines: cannot read, write or attach across companies', async () => {
    const one = <T extends object>(sql: string, values: unknown[]) =>
      owner.query<T & { id: string }>(sql, values).then((r) => r.rows[0]?.id)
    const estimateOf = async (companyId: string) => {
      const estimate = await one(
        "insert into public.estimates (company_id, title) values ($1, 'SAL') returning id",
        [companyId],
      )
      const chapter = await one(
        `insert into public.estimate_chapters (company_id, estimate_id, title, position)
         values ($1, $2, 'C', 0) returning id`,
        [companyId, estimate],
      )
      const item = await one(
        `insert into public.estimate_items (company_id, estimate_id, chapter_id, description,
           unit, unit_price_cents, position) values ($1, $2, $3, 'V', 'm²', 100, 0) returning id`,
        [companyId, estimate, chapter],
      )
      const statement = await one(
        `insert into public.progress_statements (company_id, estimate_id, number, statement_date)
         values ($1, $2, 1, '2026-10-31') returning id`,
        [companyId, estimate],
      )
      return { estimate, item, statement }
    }
    const a = await estimateOf(companyA.id)
    const b = await estimateOf(companyB.id)
    await owner.query(
      `insert into public.progress_statement_lines (company_id, estimate_id, statement_id,
         item_id, quantity, unit_price_cents) values ($1, $2, $3, $4, 1, 100)`,
      [companyB.id, b.estimate, b.statement, b.item],
    )
    const statement = (companyId: string, estimateId: unknown) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
             status, approved_at) values ($1, $2, 2, '2026-11-30', 'approved', now())`,
          [companyId, estimateId],
        ),
      )
    const line = (companyId: string, estimateId: unknown, statementId: unknown, itemId: unknown) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.progress_statement_lines (company_id, estimate_id, statement_id,
             item_id, quantity, unit_price_cents) values ($1, $2, $3, $4, 1, 100)`,
          [companyId, estimateId, statementId, itemId],
        ),
      )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const s = await c.query('select * from public.progress_statements where company_id = $1', [
        companyB.id,
      ])
      const l = await c.query(
        'select * from public.progress_statement_lines where company_id = $1',
        [companyB.id],
      )
      return s.rowCount! + l.rowCount!
    })
    expect(seen).toBe(0)
    await expect(statement(companyB.id, b.estimate)).rejects.toThrow(/row-level security/)
    await expect(statement(companyA.id, b.estimate)).rejects.toThrow(/foreign key/)
    await expect(line(companyB.id, b.estimate, b.statement, b.item)).rejects.toThrow(
      /row-level security/,
    )
    await expect(line(companyA.id, a.estimate, a.statement, b.item)).rejects.toThrow(/foreign key/)
    await expect(line(companyA.id, a.estimate, b.statement, a.item)).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query(
        "update public.progress_statements set status = 'approved', approved_at = now() where id = $1",
        [b.statement],
      )
      const l = await c.query(
        'delete from public.progress_statement_lines where statement_id = $1',
        [b.statement],
      )
      const q = await c.query(
        'update public.progress_statement_lines set quantity = 1 where statement_id = $1',
        [b.statement],
      )
      const d = await c.query('delete from public.progress_statements where id = $1', [b.statement])
      return u.rowCount! + l.rowCount! + q.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    // Lines are updated in place, only the values: never moved to another statement or company.
    for (const [set, value] of [
      ['statement_id', b.statement],
      ['company_id', companyB.id],
    ]) {
      await expect(
        as(alice.id, companyA.id, (c) =>
          c.query(`update public.progress_statement_lines set ${set} = $1`, [value]),
        ),
      ).rejects.toThrow(/permission denied/)
    }
    await expect(auth.query('select * from public.progress_statements')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.progress_statement_lines')).rejects.toThrow(
      /permission denied/,
    )
    // Other cases count every estimate row of company A: leave none behind.
    await owner.query('delete from public.progress_statements where estimate_id = $1', [a.estimate])
    await owner.query('delete from public.estimates where id = $1', [a.estimate])
  })

  it('site documents and their files: cannot read, write or attach across companies', async () => {
    const siteOf = async (companyId: string) =>
      (
        await owner.query<{ id: string }>(
          "insert into public.sites (company_id, name) values ($1, 'Documenti') returning id",
          [companyId],
        )
      ).rows[0]?.id
    const siteA = await siteOf(companyA.id)
    const siteB = await siteOf(companyB.id)
    const docOf = (companyId: string, siteId: unknown) =>
      `insert into public.site_documents (company_id, site_id, kind, title, file_name,
         content_type, size_bytes) values ('${companyId}', '${String(siteId)}', 'document', 'x',
         'x.pdf', 'application/pdf', 1) returning id`
    const docB = await owner.query<{ id: string }>(docOf(companyB.id, siteB))
    const idB = docB.rows[0]?.id
    await owner.query(
      "insert into public.site_document_files (document_id, company_id, data) values ($1, $2, '\\x25')",
      [idB, companyB.id],
    )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const d = await c.query('select * from public.site_documents where company_id = $1', [
        companyB.id,
      ])
      const f = await c.query('select * from public.site_document_files where company_id = $1', [
        companyB.id,
      ])
      return d.rowCount! + f.rowCount!
    })
    expect(seen).toBe(0)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(docOf(companyB.id, siteB))),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query(docOf(companyA.id, siteB))),
    ).rejects.toThrow(/foreign key/)
    // A file of company A cannot be hung on a document of company B, nor written as B.
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.site_document_files (document_id, company_id, data) values ($1, $2, '\\x25')",
          [idB, companyA.id],
        ),
      ),
    ).rejects.toThrow(/foreign key|duplicate key/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          "insert into public.site_document_files (document_id, company_id, data) values ($1, $2, '\\x25')",
          [idB, companyB.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query("update public.site_documents set title = 'y' where id = $1", [idB])
      const d = await c.query('delete from public.site_documents where id = $1', [idB])
      return u.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    // A document of company A cannot be linked to a daily report of company B.
    const reportB = await owner.query<{ id: string }>(
      "insert into public.daily_reports (company_id, site_id, report_date) values ($1, $2, '2026-11-06') returning id",
      [companyB.id, siteB],
    )
    await expect(
      as(alice.id, companyA.id, async (c) => {
        const own = await c.query<{ id: string }>(docOf(companyA.id, siteA))
        return c.query('update public.site_documents set daily_report_id = $1 where id = $2', [
          reportB.rows[0]?.id,
          own.rows[0]?.id,
        ])
      }),
    ).rejects.toThrow(/foreign key/)
    // The bytes are written once: the application role cannot change or delete them.
    await expect(
      as(alice.id, companyA.id, async (c) => {
        const own = await c.query<{ id: string }>(docOf(companyA.id, siteA))
        await c.query(
          "insert into public.site_document_files (document_id, company_id, data) values ($1, $2, '\\x25')",
          [own.rows[0]?.id, companyA.id],
        )
        return c.query("update public.site_document_files set data = '\\x26'")
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(auth.query('select * from public.site_documents')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.site_document_files')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('estimates: cannot be attached to a site of another company', async () => {
    const siteB = await owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'Cantiere B') returning id",
      [companyB.id],
    )
    const attach = (sql: string, params: unknown[]) =>
      as(alice.id, companyA.id, (c) => c.query(sql, params))
    await expect(
      attach("insert into public.estimates (company_id, title, site_id) values ($1, 'A', $2)", [
        companyA.id,
        siteB.rows[0]?.id,
      ]),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, async (c) => {
        const own = await c.query<{ id: string }>(
          "insert into public.estimates (company_id, title) values ($1, 'A') returning id",
          [companyA.id],
        )
        return c.query('update public.estimates set site_id = $1 where id = $2', [
          siteB.rows[0]?.id,
          own.rows[0]?.id,
        ])
      }),
    ).rejects.toThrow(/foreign key/)
  })

  it('sites: cannot be linked to a quote of another company', async () => {
    const clientB = await owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name, tax_code) values ($1, 'person', 'Cliente B', 'RSSMRA80A01L219M') returning id",
      [companyB.id],
    )
    const quoteB = await owner.query<{ id: string }>(
      `insert into public.quotes (company_id, client_id, subject, validity_days, status,
         number_year, number_seq, revision, issue_date, sent_at)
       values ($1, $2, 'Preventivo B', 30, 'accepted', 2026, 1, 0, '2026-11-02', now())
       returning id`,
      [companyB.id, clientB.rows[0]?.id],
    )
    const quoteId = quoteB.rows[0]?.id
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("insert into public.sites (company_id, name, quote_id) values ($1, 'A', $2)", [
          companyA.id,
          quoteId,
        ]),
      ),
    ).rejects.toThrow(/foreign key/)
    await expect(
      as(alice.id, companyA.id, async (c) => {
        const own = await c.query<{ id: string }>(
          "insert into public.sites (company_id, name) values ($1, 'A') returning id",
          [companyA.id],
        )
        return c.query('update public.sites set quote_id = $1 where id = $2', [
          quoteId,
          own.rows[0]?.id,
        ])
      }),
    ).rejects.toThrow(/foreign key/)
  })

  it('invoices: cannot bill a progress statement of another company', async () => {
    const estimateB = await owner.query<{ id: string }>(
      "insert into public.estimates (company_id, title) values ($1, 'Computo B') returning id",
      [companyB.id],
    )
    const statementB = await owner.query<{ id: string }>(
      `insert into public.progress_statements (company_id, estimate_id, number, statement_date,
         status, approved_at) values ($1, $2, 1, '2026-10-31', 'approved', now()) returning id`,
      [companyB.id, estimateB.rows[0]?.id],
    )
    const clientA = await owner.query<{ id: string }>(
      'select id from public.clients where company_id = $1 limit 1',
      [companyA.id],
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
             taxable_cents, vat_cents, progress_statement_id)
           values ($1, 'issued', 'X-1', '2026-11-02', $2, 100, 0, $3)`,
          [companyA.id, clientA.rows[0]?.id, statementB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
  })

  it('invoices: cannot bill a purchase order of another company', async () => {
    const supplierB = await owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore B') returning id",
      [companyB.id],
    )
    const orderB = await owner.query<{ id: string }>(
      `insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
         order_date, status, sent_at) values ($1, 2026, 901, $2, '2026-10-20', 'sent', now())
       returning id`,
      [companyB.id, supplierB.rows[0]?.id],
    )
    const supplierA = await owner.query<{ id: string }>(
      "insert into public.suppliers (company_id, name) values ($1, 'Fornitore A') returning id",
      [companyA.id],
    )
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
             taxable_cents, vat_cents, purchase_order_id)
           values ($1, 'received', 'X-1', '2026-11-02', $2, 100, 0, $3)`,
          [companyA.id, supplierA.rows[0]?.id, orderB.rows[0]?.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/)
  })

  it('price lists and their items: cannot read, write or attach across companies', async () => {
    const listB = await owner.query<{ id: string }>(
      "insert into public.price_lists (company_id, name) values ($1, 'B') returning id",
      [companyB.id],
    )
    const idB = listB.rows[0]?.id
    await owner.query(
      `insert into public.price_list_items (company_id, price_list_id, code, description, unit,
         unit_price_cents) values ($1, $2, 'B1', 'Voce B', 'm²', 100)`,
      [companyB.id, idB],
    )
    const item = (companyId: string) =>
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into public.price_list_items (company_id, price_list_id, code, description,
             unit, unit_price_cents) values ($1, $2, 'A1', 'Voce A', 'm²', 100)`,
          [companyId, idB],
        ),
      )
    const seen = await as(alice.id, companyA.id, async (c) => {
      const l = await c.query('select * from public.price_lists where company_id = $1', [
        companyB.id,
      ])
      const i = await c.query('select * from public.price_list_items where company_id = $1', [
        companyB.id,
      ])
      return l.rowCount! + i.rowCount!
    })
    expect(seen).toBe(0)
    await expect(item(companyB.id)).rejects.toThrow(/row-level security/)
    await expect(item(companyA.id)).rejects.toThrow(/foreign key/)
    const changed = await as(alice.id, companyA.id, async (c) => {
      const u = await c.query(
        "update public.price_list_items set code = 'X' where price_list_id = $1",
        [idB],
      )
      const d = await c.query('delete from public.price_lists where id = $1', [idB])
      return u.rowCount! + d.rowCount!
    })
    expect(changed).toBe(0)
    await expect(auth.query('select * from public.price_lists')).rejects.toThrow(
      /permission denied/,
    )
    await expect(auth.query('select * from public.price_list_items')).rejects.toThrow(
      /permission denied/,
    )
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
    // Nor the logo ones: through them a token would open the logo of any company.
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select * from auth.invitation_logo($1)', [hash])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select auth.invitation_has_logo($1)', [hash])),
    ).rejects.toThrow(/permission denied/)
    // Membership of the other company is not revealed.
    const bob = await fx.user()
    await fx.member(bob.id, companyB.id, roleB)
    const seen = await as(alice.id, companyA.id, (c) =>
      c.query<{ m: boolean }>('select app.is_company_member($1) as m', [bob.email]),
    )
    expect(seen.rows[0]?.m).toBe(false)
  })

  it('company logos: my_companies_with_logo names only the companies of the user', async () => {
    for (const id of [companyA.id, companyB.id]) {
      await owner.query(
        `insert into public.company_logos (company_id, content_type, data)
         values ($1, 'image/png', '\\x89504e47') on conflict (company_id) do nothing`,
        [id],
      )
    }
    const { rows } = await as(alice.id, companyA.id, (c) =>
      c.query<{ id: string }>('select app.my_companies_with_logo() as id'),
    )
    expect(rows.map((r) => r.id)).toContain(companyA.id)
    expect(rows.map((r) => r.id)).not.toContain(companyB.id)
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
    // The auth role can change the email (confirmed email change), never activate accounts.
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

  it('email changes: the API role cannot read or write them', async () => {
    await expect(
      as(alice.id, companyA.id, (c) => c.query('select * from auth.email_changes')),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query(
          `insert into auth.email_changes (user_id, new_email, token_hash, expires_at)
           values ($1, 'preso@example.test', $2, now())`,
          [alice.id, 'e'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(alice.id, companyA.id, (c) =>
        c.query("update auth.users set email = 'preso@example.test' where id = $1", [alice.id]),
      ),
    ).rejects.toThrow(/permission denied/)
    // The auth role can mark a token used, but cannot move it or change its address.
    await expect(
      auth.query('update auth.email_changes set user_id = $1 where false', [alice.id]),
    ).rejects.toThrow(/permission denied/)
    await expect(
      auth.query("update auth.email_changes set new_email = 'x@example.test' where false"),
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
        "select user_id, fields from public.audit_log where action = 'update' and entity = 'client'",
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
    for (const fn of ['app.audit_child_row()', 'app.audit_site_team()']) {
      await expect(as(alice.id, companyA.id, (c) => c.query(`select ${fn}`))).rejects.toThrow(
        /permission denied|trigger/,
      )
    }
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
