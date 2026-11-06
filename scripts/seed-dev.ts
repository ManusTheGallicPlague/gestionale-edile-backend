/**
 * Development data, the same companies and users as the frontend's mocks (src/mocks/data.ts),
 * so the frontend can switch from mocks to this API without changing anything.
 * Made-up data only. Refuses to run on a database that holds other companies.
 */
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { hashPassword } from '../src/auth/password.js'
import { codiceFiscaleCheckLetter, partitaIvaCheckDigit } from '../src/clients/tax-ids.js'

export const DEV_PASSWORD = 'cantiere-demo'

const ALL = [
  'clients.view',
  'clients.create',
  'clients.update',
  'clients.delete',
  'suppliers.view',
  'suppliers.create',
  'suppliers.update',
  'suppliers.delete',
  'deadlines.view',
  'deadlines.create',
  'deadlines.update',
  'deadlines.delete',
  'estimates.view',
  'estimates.create',
  'estimates.update',
  'estimates.delete',
  'quotes.view',
  'quotes.create',
  'quotes.update',
  'quotes.delete',
]
const ROLES: Record<string, string[]> = {
  Titolare: ALL,
  Ufficio: ALL.filter((p) => !p.endsWith('.delete')),
  'Capo cantiere': ['clients.view', 'suppliers.view', 'deadlines.view', 'estimates.view'],
  // The site manager does not see quotes: prices and margins stay with the office.
}

const COMPANIES = [
  { slug: 'impresa-rossi', name: 'Impresa Rossi S.r.l.', clients: 60, seed: 1 },
  { slug: 'costruzioni-verdi', name: 'Costruzioni Verdi S.p.A.', clients: 5, seed: 2 },
]

const USERS = [
  {
    name: 'Giulia Rossi',
    email: 'titolare@example.test',
    memberships: { 'impresa-rossi': 'Titolare', 'costruzioni-verdi': 'Ufficio' },
  },
  {
    name: 'Luca Bianchi',
    email: 'ufficio@example.test',
    memberships: { 'impresa-rossi': 'Ufficio' },
  },
  {
    name: 'Marco Neri',
    email: 'capocantiere@example.test',
    memberships: { 'impresa-rossi': 'Capo cantiere' },
  },
  { name: 'Sara Galli', email: 'nuovo@example.test', memberships: {} },
] satisfies { name: string; email: string; memberships: Record<string, string> }[]

const SURNAMES = (
  'Ferri,Colombo,Ricci,Marino,Greco,Bruno,Gallo,Conti,De Luca,Costa,' +
  'Giordano,Mancini,Rizzo,Lombardi,Moretti,Barbieri,Fontana,Santoro,Mariani,Rinaldi'
).split(',')
const FIRST_NAMES = ['Anna', 'Paolo', 'Elena']
const CITIES = [
  { city: 'Torino', province: 'TO', postal_code: '10121' },
  { city: 'Milano', province: 'MI', postal_code: '20121' },
  { city: 'Novara', province: 'NO', postal_code: '28100' },
  { city: 'Asti', province: 'AT', postal_code: '14100' },
]
const pick = <T>(list: readonly T[], i: number) => list[i % list.length] as T

function partitaIva(n: number): string {
  const first10 = String(n).padStart(10, '0').slice(-10)
  return first10 + partitaIvaCheckDigit(first10)
}

function codiceFiscale(surname: string, i: number): string {
  const consonants = surname
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .padEnd(3, 'X')
    .slice(0, 3)
  const day = String((i % 28) + 1).padStart(2, '0')
  const first15 = `${consonants}XYZ80A${day}L219`
  return first15 + codiceFiscaleCheckLetter(first15)
}

export function devClients(count: number, seed: number) {
  return Array.from({ length: count }, (_, i) => {
    const surname = pick(SURNAMES, i)
    const round = Math.floor(i / SURNAMES.length)
    const form = i % 3
    const base = seed * 100_000_000 + i * 1013
    if (form === 2) {
      return {
        kind: 'person',
        name: `${pick(FIRST_NAMES, round)} ${surname}`,
        vat_number: null,
        tax_code: codiceFiscale(surname, i + seed),
        pec: null,
        sdi_code: null,
        i,
      }
    }
    const condominium = form === 1 && round % 2 === 1
    return {
      kind: 'company',
      name: condominium
        ? `Condominio Via ${surname}`
        : `${round % 2 === 0 ? 'Edil' : 'Immobiliare'} ${surname} S.r.l.`,
      // A condominium has a numeric codice fiscale and no partita IVA.
      vat_number: condominium ? null : partitaIva(base),
      // Codici fiscali of condominiums start with 9 and use the partita IVA check digit.
      tax_code: condominium ? partitaIva(9_000_000_000 + (base % 1_000_000_000)) : null,
      pec: `cliente${i + 1}@pec.example.test`,
      sdi_code: 'ABC1234',
      i,
    }
  }).map(({ i, ...client }) => ({
    ...client,
    email: `cliente${i + 1}@example.test`,
    phone: `011 555 ${1000 + i}`,
    street: `Via ${pick(SURNAMES, i)} ${i + 1}`,
    ...pick(CITIES, i),
    country: 'IT',
    notes: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i, 9)),
  }))
}

/** Made-up suppliers: one per category, two subcontractors. */
export function devSuppliers(seed: number) {
  const rows = [
    { name: 'Laterizi del Nord S.r.l.', categories: ['materials'], subcontractor: false },
    { name: 'Calcestruzzi Pianura S.p.A.', categories: ['materials'], subcontractor: false },
    { name: 'Noli e Gru S.r.l.', categories: ['rentals'], subcontractor: false },
    {
      name: 'Impianti Elettrici Bassi',
      categories: ['subcontracting'],
      subcontractor: true,
    },
    {
      name: 'Idraulica Moderna S.n.c.',
      categories: ['subcontracting', 'materials'],
      subcontractor: true,
    },
    { name: 'Studio Tecnico Associato', categories: ['services'], subcontractor: false },
  ]
  return rows.map((row, i) => {
    const base = seed * 100_000_000 + 50_000_000 + i * 7919
    return {
      ...row,
      vat_number: partitaIva(base),
      email: `fornitore${i + 1}@example.test`,
      phone: `011 666 ${1000 + i}`,
      street: `Via dei Fornitori ${i + 1}`,
      ...pick(CITIES, i),
      created_at: new Date(Date.UTC(2026, 1, 1 + i, 9)),
    }
  })
}

export async function seedDev(ownerUrl: string, { force = false } = {}) {
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ slug: string }>('select slug from public.companies')
    const ours = new Set(COMPANIES.map((c) => c.slug))
    const others = rows.filter((r) => !ours.has(r.slug))
    if (others.length > 0 && !force) {
      throw new Error(
        `There are ${others.length} other companies: this does not look like a development ` +
          'database. Set SEED_FORCE=1 if you are sure.',
      )
    }

    await client.query('begin')
    const companyIds: Record<string, string> = {}
    const roleIds: Record<string, string> = {}
    for (const company of COMPANIES) {
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into public.companies (slug, name) values ($1, $2)
         on conflict (slug) do update set name = excluded.name returning id`,
        [company.slug, company.name],
      )
      const companyId = inserted[0]?.id ?? ''
      companyIds[company.slug] = companyId
      for (const [role, permissions] of Object.entries(ROLES)) {
        const { rows: r } = await client.query<{ id: string }>(
          `insert into public.roles (company_id, name) values ($1, $2)
           on conflict (company_id, name) do update set name = excluded.name returning id`,
          [companyId, role],
        )
        const roleId = r[0]?.id ?? ''
        roleIds[`${company.slug}/${role}`] = roleId
        await client.query('delete from public.role_permissions where role_id = $1', [roleId])
        for (const permission of permissions) {
          await client.query(
            'insert into public.role_permissions (role_id, permission) values ($1, $2)',
            [roleId, permission],
          )
        }
      }
      await client.query('delete from public.deadlines where company_id = $1', [companyId])
      await client.query('delete from public.quotes where company_id = $1', [companyId])
      await client.query('delete from public.estimates where company_id = $1', [companyId])
      await client.query('delete from public.clients where company_id = $1', [companyId])
      for (const [i, c] of devClients(company.clients, company.seed).entries()) {
        await client.query(
          `insert into public.clients (company_id, kind, name, vat_number, tax_code, email, pec,
             phone, sdi_code, street, postal_code, city, province, country, notes, created_at, updated_at,
             archived_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,
             case when $17::boolean then $16::timestamptz end)`,
          [
            companyId,
            c.kind,
            c.name,
            c.vat_number,
            c.tax_code,
            c.email,
            c.pec,
            c.phone,
            c.sdi_code,
            c.street,
            c.postal_code,
            c.city,
            c.province,
            c.country,
            c.notes,
            c.created_at,
            // A few archived clients, to try the archive filter.
            i % 20 === 19,
          ],
        )
      }
    }

    for (const company of COMPANIES) {
      const companyId = companyIds[company.slug]
      await client.query('delete from public.deadlines where company_id = $1', [companyId])
      await client.query('delete from public.supplier_documents where company_id = $1', [companyId])
      await client.query('delete from public.suppliers where company_id = $1', [companyId])
      for (const s of devSuppliers(company.seed)) {
        const { rows: inserted } = await client.query<{ id: string }>(
          `insert into public.suppliers (company_id, name, vat_number, email, phone, street,
             postal_code, city, province, categories, subcontractor, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
           returning id`,
          [
            companyId,
            s.name,
            s.vat_number,
            s.email,
            s.phone,
            s.street,
            s.postal_code,
            s.city,
            s.province,
            s.categories,
            s.subcontractor,
            s.created_at,
          ],
        )
        if (!s.subcontractor) continue
        // Compliance documents relative to today: one expired, one expiring, one valid.
        await client.query(
          `insert into public.supplier_documents (company_id, supplier_id, kind, issued_on, expires_on)
           select $1, $2, d.kind, current_date + d.issued, current_date + d.expires
           from (values ('durc', -100, 20), ('insurance', -400, -5), ('chamber_extract', -30, 150))
             as d (kind, issued, expires)`,
          [companyId, inserted[0]?.id],
        )
      }
    }

    for (const company of COMPANIES) {
      const companyId = companyIds[company.slug]
      await client.query(
        'update public.deadlines set next_deadline_id = null where company_id = $1',
        [companyId],
      )
      await client.query('delete from public.deadlines where company_id = $1', [companyId])
      // Deadlines relative to today, so the calendar and the dashboard always have something.
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, status, done_at,
           recurrence)
         select $1, d.title, current_date + d.days, d.kind, d.cents,
           case when d.done then 'done' else 'open' end, case when d.done then now() end,
           case when d.kind = 'tax' and d.title like 'F24%' and not d.done then 'monthly' end
         from (values
           ('F24 ritenute e contributi', -3, 'tax', 412300::bigint, false),
           ('Revisione autocarro', 5, 'vehicle', 8900::bigint, false),
           ('Rata assicurazione RCT/RCO', 12, 'insurance', 185000::bigint, false),
           ('Rinnovo contratto di noleggio gru', 25, 'contract', null::bigint, false),
           ('Saldo IVA trimestrale', 45, 'tax', 1250000::bigint, false),
           ('F24 del mese scorso', -33, 'tax', 398000::bigint, true)
         ) as d (title, days, kind, cents, done)`,
        [companyId],
      )
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, client_id)
         select $1, 'Incasso fattura ' || c.name, current_date + 20, 'invoice_out', 2440000, c.id
         from public.clients c where c.company_id = $1 and c.archived_at is null
         order by c.created_at limit 1`,
        [companyId],
      )
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, supplier_id)
         select $1, 'Pagamento fattura ' || s.name, current_date + 8, 'invoice_in', 735000, s.id
         from public.suppliers s where s.company_id = $1
         order by s.created_at limit 1`,
        [companyId],
      )
      // The suppliers' documents in the calendar, as the API does when they are saved.
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, supplier_id,
           supplier_document_id)
         select sd.company_id,
           case sd.kind when 'durc' then 'DURC' when 'insurance' then 'Assicurazione'
             else 'Visura camerale' end || ' – ' || s.name,
           sd.expires_on, case when sd.kind in ('durc', 'insurance') then sd.kind else 'other' end,
           sd.supplier_id, sd.id
         from public.supplier_documents sd join public.suppliers s on s.id = sd.supplier_id
         where sd.company_id = $1 and sd.expires_on is not null`,
        [companyId],
      )
    }

    for (const company of COMPANIES) {
      const companyId = companyIds[company.slug]
      await client.query('delete from public.quotes where company_id = $1', [companyId])
      await client.query('delete from public.quote_counters where company_id = $1', [companyId])
      await client.query(
        `insert into public.quotes (company_id, client_id, subject, validity_days, terms, status,
           number_year, number_seq, revision, issue_date, sent_at)
         select $1, c.id, q.subject, 30, 'Pagamento: 30% all''ordine, saldo a fine lavori.',
           q.status, q.year, q.seq, case when q.seq is not null then 0 end,
           q.issue_date::date, q.issue_date::timestamptz
         from (values
           ('Rifacimento copertura', 'sent', 2026, 1, '2026-10-12', 0),
           ('Ristrutturazione bagno', 'accepted', 2026, 2, '2026-10-20', 1),
           ('Cappotto termico facciata nord', 'draft', null, null, null, 0)
         ) as q (subject, status, year, seq, issue_date, n)
         join lateral (
           select id from public.clients where company_id = $1 and archived_at is null
           order by created_at offset q.n limit 1
         ) c on true`,
        [companyId],
      )
      // A draft revision of the first quote, sent but not yet answered.
      await client.query(
        `insert into public.quotes (company_id, client_id, subject, validity_days, terms,
           revision_of_id)
         select company_id, client_id, subject, validity_days, terms, id from public.quotes
         where company_id = $1 and number_year = 2026 and number_seq = 1`,
        [companyId],
      )
      await client.query(
        'insert into public.quote_counters (company_id, year, last_number) values ($1, 2026, 2)',
        [companyId],
      )
      await client.query(
        `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
           unit_price_cents, discount_percent, vat_rate, position)
         select q.company_id, q.id, l.kind, l.description, l.unit, l.quantity, l.cents,
           l.discount, l.vat, l.position
         from public.quotes q
         cross join (values
           ('section', 'Copertura', null, null, null, null, null, 0),
           ('item', 'Rimozione del manto di copertura in coppi', 'm²', 120.5, 1840, 0, 10, 1),
           ('item', 'Fornitura e posa di guaina impermeabilizzante', 'm²', 120.5, 2250, 5, 10, 2),
           ('text', 'Ponteggi esclusi, a carico del committente.', null, null, null, null, null, 3)
         ) as l (kind, description, unit, quantity, cents, discount, vat, position)
         where q.company_id = $1`,
        [companyId],
      )
      await client.query('delete from public.estimates where company_id = $1', [companyId])
      await client.query(
        `insert into public.estimates (company_id, title, client_id, site_address, status)
         select $1, e.title, c.id, e.address, e.status
         from (values
           ('Rifacimento copertura', 'Via Roma 1, Torino', 'draft', 0),
           ('Ristrutturazione bagno', 'Corso Francia 20, Torino', 'final', 1),
           ('Cappotto termico facciata nord', null, 'draft', 2)
         ) as e (title, address, status, n)
         left join lateral (
           select id from public.clients where company_id = $1 and archived_at is null
           order by created_at offset e.n limit 1
         ) c on e.n < 2`,
        [companyId],
      )
      await client.query(
        `with e as (
           select id from public.estimates
           where company_id = $1 and title = 'Ristrutturazione bagno'
         ), ch as (
           insert into public.estimate_chapters (company_id, estimate_id, code, title, position)
           select $1, e.id, v.code, v.title, v.position
           from e, (values ('A', 'Demolizioni e rimozioni', 0), ('B', 'Impianti', 1))
             as v (code, title, position)
           returning id, code, estimate_id
         )
         insert into public.estimate_items
           (company_id, estimate_id, chapter_id, code, description, unit, unit_price_cents, position)
         select $1, ch.estimate_id, ch.id, v.code, v.description, v.unit, v.cents, v.position
         from ch join (values
           ('A', 'DEM.001', 'Demolizione di pavimento in piastrelle, compreso il sottofondo', 'm²', 1850, 0),
           ('A', 'DEM.002', 'Rimozione di sanitari, compreso il trasporto a discarica', 'cad', 4500, 1),
           ('B', 'IDR.010', 'Punto acqua calda e fredda in multistrato', 'cad', 12000, 0)
         ) as v (chapter, code, description, unit, cents, position) on v.chapter = ch.code`,
        [companyId],
      )
      await client.query(
        `insert into public.estimate_measurements
           (company_id, estimate_id, item_id, description, equal_parts, length, width, position)
         select i.company_id, i.estimate_id, i.id, v.description, v.parts, v.length, v.width,
           v.position
         from public.estimate_items i
         join (values
           ('DEM.001', 'Bagno', null, 3.2, 2.5, 0),
           ('DEM.001', 'Antibagno', null, 1.5, 1.2, 1),
           ('DEM.001', 'Piatto doccia (da detrarre)', -1, 0.8, 0.8, 2),
           ('DEM.002', 'Sanitari', 4, null, null, 0),
           ('IDR.010', 'Lavabo, bidet, doccia', 3, null, null, 0)
         ) as v (code, description, parts, length, width, position) on v.code = i.code
         where i.company_id = $1`,
        [companyId],
      )
    }

    const passwordHash = await hashPassword(DEV_PASSWORD)
    for (const user of USERS) {
      const { rows: u } = await client.query<{ id: string }>(
        `insert into auth.users (email, name, password_hash) values ($1, $2, $3)
         on conflict (email) do update set name = excluded.name, password_hash = excluded.password_hash,
           active = true
         returning id`,
        [user.email, user.name, passwordHash],
      )
      const userId = u[0]?.id ?? ''
      await client.query('delete from public.memberships where user_id = $1', [userId])
      for (const [slug, role] of Object.entries(user.memberships)) {
        await client.query(
          'insert into public.memberships (user_id, company_id, role_id) values ($1, $2, $3)',
          [userId, companyIds[slug], roleIds[`${slug}/${role}`]],
        )
      }
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL_OWNER
  if (!url) {
    console.error('✗ Missing DATABASE_URL_OWNER (see .env.example)')
    process.exit(1)
  }
  seedDev(url, { force: process.env.SEED_FORCE === '1' })
    .then(() => {
      console.log('✓ Development data ready')
      console.log(`  users: ${USERS.map((u) => u.email).join(', ')}`)
      console.log(`  password for all of them: ${DEV_PASSWORD} (development only)`)
      console.log(`  companies: ${COMPANIES.map((c) => c.slug).join(', ')}`)
    })
    .catch((error: unknown) => {
      console.error(`✗ ${(error as Error).message}`)
      process.exit(1)
    })
}
