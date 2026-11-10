/**
 * Development data, the same companies and users as the frontend's mocks (src/mocks/data.ts),
 * so the frontend can switch from mocks to this API without changing anything.
 * Made-up data only. Refuses to run on a database that holds other companies.
 */
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { sha256 } from '../src/auth/crypto.js'
import { hashPassword } from '../src/auth/password.js'
import { codiceFiscaleCheckLetter, partitaIvaCheckDigit } from '../src/clients/tax-ids.js'

export const DEV_PASSWORD = 'cantiere-demo'
export const DEV_INVITATION_TOKEN = 'invito-di-sviluppo-impresa-rossi'

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
  'estimates.approve',
  'sites.view',
  'sites.create',
  'sites.update',
  'sites.delete',
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.delete',
  'vehicles.view',
  'vehicles.create',
  'vehicles.update',
  'vehicles.delete',
  'reports.view',
  'reports.create',
  'reports.update',
  'reports.delete',
  'reports.approve',
  'costs.view',
  'costs.create',
  'costs.update',
  'costs.delete',
  'documents.view',
  'documents.create',
  'documents.update',
  'documents.delete',
  'price_lists.view',
  'price_lists.create',
  'price_lists.update',
  'price_lists.delete',
  'purchases.view',
  'purchases.create',
  'purchases.update',
  'purchases.delete',
  'warehouse.view',
  'warehouse.create',
  'warehouse.update',
  'warehouse.delete',
  'invoices.view',
  'invoices.create',
  'invoices.update',
  'invoices.delete',
  'quotes.view',
  'quotes.create',
  'quotes.update',
  'quotes.delete',
  'settings.view',
  'settings.update',
  'users.view',
  'users.manage',
  'roles.manage',
  'audit.view',
]
const ROLES: Record<string, string[]> = {
  Titolare: ALL,
  // The office sees the company data but only the owner changes it, or sees users and roles.
  Ufficio: ALL.filter(
    (p) =>
      !p.endsWith('.delete') &&
      p !== 'settings.update' &&
      !p.startsWith('users.') &&
      !p.startsWith('roles.') &&
      p !== 'audit.view',
  ),
  'Capo cantiere': [
    'clients.view',
    'suppliers.view',
    'deadlines.view',
    'estimates.view',
    'sites.view',
    'reports.view',
    'reports.create',
    'reports.update',
    'documents.view',
    'documents.create',
    // Takes material to the site from the phone.
    'warehouse.view',
    'warehouse.create',
  ],
  // The site manager does not see quotes: prices and margins stay with the office.
}

/** A one-page PDF and a 1×1 PNG for the site archive. */
const DEV_FILES = [
  {
    kind: 'document',
    title: 'Verbale di consegna lavori',
    name: 'verbale-consegna.pdf',
    type: 'application/pdf',
    data: Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
        'trailer<</Root 1 0 R>>\n%%EOF\n',
    ),
  },
  {
    kind: 'photo',
    title: 'Scavo di fondazione',
    name: 'scavo.png',
    type: 'image/png',
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  },
]

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
      // Invoices point to clients, suppliers and sites: they go first.
      await client.query('delete from public.invoices where company_id = $1', [companyId])
      // Sites created from a quote keep it: unlink them, so the quotes can be replaced.
      await client.query('update public.sites set quote_id = null where company_id = $1', [
        companyId,
      ])
      await client.query('delete from public.quotes where company_id = $1', [companyId])
      // Daily reports point to sites, employees and vehicles: they go first.
      await client.query('delete from public.daily_reports where company_id = $1', [companyId])
      await client.query('delete from public.site_costs where company_id = $1', [companyId])
      // Warehouse movements point to sites: they go first, then the items.
      await client.query('delete from public.warehouse_movements where company_id = $1', [
        companyId,
      ])
      await client.query('delete from public.warehouse_items where company_id = $1', [companyId])
      // Purchase orders point to sites and suppliers: they go first.
      await client.query('delete from public.purchase_orders where company_id = $1', [companyId])
      await client.query('delete from public.site_documents where company_id = $1', [companyId])
      // Estimates point to sites: they go first.
      // Progress statements keep their estimate: they go first.
      await client.query('delete from public.progress_statements where company_id = $1', [
        companyId,
      ])
      await client.query('delete from public.estimates where company_id = $1', [companyId])
      await client.query('delete from public.sites where company_id = $1', [companyId])
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
      // Maintenance jobs point to suppliers (the workshop): they go first.
      await client.query('delete from public.vehicle_maintenances where company_id = $1', [
        companyId,
      ])
      await client.query('delete from public.vehicle_refuelings where company_id = $1', [companyId])
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
        // The DURC comes with its (tiny, made-up) PDF.
        const durcPdf = Buffer.from('%PDF-1.4\n% DURC di prova\n%%EOF\n')
        await client.query(
          `insert into public.supplier_document_files
             (document_id, company_id, file_name, content_type, size_bytes, data)
           select sd.id, $1, 'durc.pdf', 'application/pdf', $3, $4
           from public.supplier_documents sd where sd.supplier_id = $2 and sd.kind = 'durc'`,
          [companyId, inserted[0]?.id, durcPdf.length, durcPdf],
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
      // Made-up tax data: a valid-looking partita IVA from the company's seed.
      const vatBase = String(1_000_000_000 + company.seed * 123_456_789).slice(0, 10)
      await client.query(
        `insert into public.company_profiles (company_id, legal_name, vat_number, tax_code, rea,
           share_capital_cents, street, postal_code, city, province, phone, email, pec, iban,
           patron_saint_day)
         values ($1, $2, $3, $3, $4, 1000000, 'Via dell''Industria 12', '10100', 'Torino', 'TO',
           '011 000 0000', $5, null, 'IT60X0542811101000000123456', '06-24')
         on conflict (company_id) do update set legal_name = excluded.legal_name,
           vat_number = excluded.vat_number, tax_code = excluded.tax_code,
           patron_saint_day = excluded.patron_saint_day`,
        [
          companyId,
          company.name,
          vatBase + partitaIvaCheckDigit(vatBase),
          `TO-${100000 + company.seed}`,
          `info@${company.slug}.example.test`,
        ],
      )
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
      // The façade is done for a general contractor: reverse charge of the building trade.
      await client.query(
        `insert into public.quote_lines (company_id, quote_id, kind, description, unit, quantity,
           unit_price_cents, discount_percent, vat_rate, vat_nature, position)
         select company_id, id, 'item', 'Posa di cappotto termico in EPS da 10 cm', 'm²', 340,
           4800, 0, 0, 'N6.7', 4
         from public.quotes
         where company_id = $1 and subject = 'Cappotto termico facciata nord'`,
        [companyId],
      )
      await client.query('delete from public.vehicles where company_id = $1', [companyId])
      await client.query(
        `insert into public.vehicles (company_id, name, kind, plate, hourly_cost_cents)
         select $1, v.name, v.kind, v.plate, v.cost
         from (values
           ('Furgone cassonato', 'vehicle', 'AA000AA', 1500),
           ('Miniescavatore 3,5 t', 'machine', null, 4500),
           ('Betoniera 350 l', 'equipment', null, 300)
         ) as v (name, kind, plate, cost)`,
        [companyId],
      )
      await client.query(
        `insert into public.vehicle_maintenances (company_id, vehicle_id, performed_on, kind,
           description, supplier_id, amount_cents, meter_reading, next_due_on)
         select $1, v.id, current_date - m.ago, m.kind, m.description,
           (select id from public.suppliers where company_id = $1 order by name limit 1),
           m.cents, m.meter, current_date + m.next_in
         from (values
           ('AA000AA', 200, 'service', 'Tagliando con cambio olio e filtri', 38000, 84500, 165),
           ('AA000AA', 40, 'tires', 'Quattro gomme invernali', 52000, 91200, null),
           (null, 90, 'repair', 'Sostituzione tubo idraulico del braccio', 21550, 1340, null)
         ) as m (plate, ago, kind, description, cents, meter, next_in)
         join public.vehicles v on v.company_id = $1
           and (v.plate = m.plate or (m.plate is null and v.kind = 'machine'))`,
        [companyId],
      )
      // The next service in the calendar, as the API does when the job is recorded.
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, vehicle_id,
           vehicle_maintenance_id)
         select m.company_id, 'Prossimo tagliando – ' || v.name, m.next_due_on, 'vehicle',
           m.vehicle_id, m.id
         from public.vehicle_maintenances m
         join public.vehicles v on v.id = m.vehicle_id
         where m.company_id = $1 and m.next_due_on is not null`,
        [companyId],
      )
      // Three fill-ups of the van, the last one without the station.
      await client.query(
        `insert into public.vehicle_refuelings (company_id, vehicle_id, refueled_on, liters,
           amount_cents, meter_reading, supplier_id)
         select $1, v.id, current_date - r.ago, r.liters, r.cents, r.meter,
           case when r.station
             then (select id from public.suppliers where company_id = $1 order by name limit 1)
           end
         from (values
           (30, 52.40, 9170, 90100, true),
           (16, 48.75, 8460, 90820, true),
           (2, 20.00, 3600, 91350, false)
         ) as r (ago, liters, cents, meter, station)
         join public.vehicles v on v.company_id = $1 and v.plate = 'AA000AA'`,
        [companyId],
      )
      // Insurance and road tax of the van (the tax expiring soon), and its registration.
      await client.query(
        `insert into public.vehicle_documents (company_id, vehicle_id, kind, description,
           issued_on, expires_on)
         select $1, v.id, d.kind, d.description, current_date - d.issued_ago,
           current_date + d.expires_in
         from (values
           ('insurance', 'Polizza RCA n. 0000123', 300, 65),
           ('road_tax', null, 340, 25),
           ('registration', null, 2000, null)
         ) as d (kind, description, issued_ago, expires_in)
         join public.vehicles v on v.company_id = $1 and v.plate = 'AA000AA'`,
        [companyId],
      )
      // Their deadlines, as the API does when the document is recorded.
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, vehicle_id,
           vehicle_document_id)
         select d.company_id,
           coalesce(d.description, case d.kind when 'insurance' then 'Assicurazione'
             else 'Bollo' end) || ' – ' || v.name,
           d.expires_on, 'vehicle', d.vehicle_id, d.id
         from public.vehicle_documents d
         join public.vehicles v on v.id = d.vehicle_id
         where d.company_id = $1 and d.expires_on is not null`,
        [companyId],
      )
      await client.query('delete from public.employees where company_id = $1', [companyId])
      await client.query(
        `insert into public.employees (company_id, first_name, last_name, job_title, hired_on,
           hourly_cost_cents, active, annual_leave_days, annual_permit_hours)
         select $1, e.first_name, e.last_name, e.job_title, e.hired_on::date, e.cost, e.active,
           e.leave, e.permit
         from (values
           ('Marco', 'Ferri', 'Capo squadra', '2015-04-01', 3400, true, 26, 88),
           ('Luca', 'Galli', 'Muratore', '2019-09-16', 2850, true, 26, 88),
           ('Paolo', 'Riva', 'Carpentiere', '2021-02-01', 2700, true, 20, 72),
           ('Andrea', 'Conti', 'Manovale', '2018-06-04', 2400, false, null::smallint, null::smallint)
         ) as e (first_name, last_name, job_title, hired_on, cost, active, leave, permit)`,
        [companyId],
      )
      // Documents of the employees: fitness for the job (one expiring soon), safety training
      // and a crane licence without expiry; their deadlines as the API makes them.
      await client.query(
        `insert into public.employee_documents (company_id, employee_id, kind, description,
           issued_on, expires_on)
         select $1, e.id, d.kind, d.description, current_date - d.issued_ago,
           current_date + d.expires_in
         from (values
           ('Ferri', 'medical_check', null, 340, 25),
           ('Ferri', 'safety_training', null, 700, 1100),
           ('Galli', 'medical_check', null, 100, 265),
           ('Galli', 'license', 'Patentino gru su autocarro', 400, null)
         ) as d (last_name, kind, description, issued_ago, expires_in)
         join public.employees e on e.company_id = $1 and e.last_name = d.last_name`,
        [companyId],
      )
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, employee_id,
           employee_document_id)
         select $1,
           coalesce(d.description, case d.kind when 'medical_check' then 'Idoneità sanitaria'
             else 'Formazione sicurezza' end) || ' – ' || e.last_name || ' ' || e.first_name,
           d.expires_on, case d.kind when 'medical_check' then 'medical_check' else 'training' end,
           d.employee_id, d.id
         from public.employee_documents d
         join public.employees e on e.id = d.employee_id
         where d.company_id = $1 and d.expires_on is not null`,
        [companyId],
      )
      // Absences of the employees: a week of holiday, a sick day and two hours of leave.
      await client.query(
        `insert into public.employee_absences (company_id, employee_id, kind, starts_on, ends_on,
           hours, notes)
         select $1, e.id, a.kind, current_date + a.from_day, current_date + a.to_day,
           a.hours::numeric, a.notes
         from (values
           ('Galli', 'vacation', 14, 18, null, null),
           ('Riva', 'sick_leave', -3, -3, null, null),
           ('Ferri', 'leave', 2, 2, '2.00', 'Visita specialistica')
         ) as a (last_name, kind, from_day, to_day, hours, notes)
         join public.employees e on e.company_id = $1 and e.last_name = a.last_name`,
        [companyId],
      )
      // Vacation and leave hours carried over from last year, as the payslip shows them.
      await client.query(
        `insert into public.employee_leave_carryovers
           (company_id, employee_id, year, days, permit_hours)
         select $1, e.id, extract(year from current_date)::int, c.days, c.hours::numeric
         from (values ('Ferri', 4, '12.50'), ('Riva', -1, null), ('Galli', null, '6.00'))
           as c (last_name, days, hours)
         join public.employees e on e.company_id = $1 and e.last_name = c.last_name`,
        [companyId],
      )
      await client.query('delete from public.sites where company_id = $1', [companyId])
      await client.query(
        `insert into public.sites (company_id, code, name, client_id, address, status, start_on,
           end_on, budget_cents, latitude, longitude)
         select $1, s.code, s.name, c.id, s.address, s.status, s.start_on::date, s.end_on::date,
           s.budget, s.latitude::numeric, s.longitude::numeric
         from (values
           ('2026-01', 'Rifacimento copertura condominio', 'Via Roma 1, Torino', 'active',
             '2026-10-05', '2026-12-18', 6500000, 0, '45.067700', '7.682400'),
           ('2026-02', 'Ristrutturazione bagno', 'Corso Francia 20, Torino', 'planned',
             '2026-11-23', '2026-12-11', 1200000, 1, '45.077000', '7.650000'),
           ('2025-07', 'Cappotto termico facciata nord', 'Via Po 3, Torino', 'completed',
             '2025-05-12', '2025-09-30', null, 0, null, null)
         ) as s (code, name, address, status, start_on, end_on, budget, n, latitude, longitude)
         left join lateral (
           select id from public.clients where company_id = $1 and archived_at is null
           order by created_at offset s.n limit 1
         ) c on true`,
        [companyId],
      )
      // The bathroom site comes from the accepted quote 2026/002 (createSiteFromQuote).
      await client.query(
        `update public.sites s set quote_id = q.id
         from public.quotes q
         where s.company_id = $1 and s.code = '2026-02'
           and q.company_id = $1 and q.number_year = 2026 and q.number_seq = 2`,
        [companyId],
      )
      await client.query(
        `insert into public.site_team (company_id, site_id, employee_id)
         select $1, s.id, e.id
         from public.sites s
         join public.employees e on e.company_id = s.company_id and e.active
         where s.company_id = $1 and s.code = '2026-01'`,
        [companyId],
      )
      // Deadlines of an employee, a vehicle and a site.
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, recurrence, employee_id,
           vehicle_id, site_id)
         select $1, 'Visita medica periodica', current_date + 20, 'medical_check', 'yearly'::text,
           (select id from public.employees where company_id = $1 and last_name = 'Ferri'),
           null::uuid, null::uuid
         union all
         select $1, 'Aggiornamento corso sicurezza', current_date + 45, 'training', null,
           (select id from public.employees where company_id = $1 and last_name = 'Galli'),
           null, null
         union all
         select $1, 'Revisione furgone', current_date + 12, 'vehicle', 'biennial', null,
           (select id from public.vehicles where company_id = $1 and plate = 'AA000AA'), null
         union all
         select $1, 'Scadenza occupazione suolo pubblico', current_date + 30, 'other', null,
           null, null, (select id from public.sites where company_id = $1 and code = '2026-01')`,
        [companyId],
      )
      await client.query(
        `insert into public.daily_reports (company_id, site_id, report_date, status, weather,
           work_done, submitted_at, approved_at)
         select $1, s.id, r.day::date, r.status, r.weather, r.work_done,
           case when r.status <> 'draft' then now() end,
           case when r.status = 'approved' then now() end
         from public.sites s, (values
           ('2026-11-04', 'approved', 'Sereno', 'Scavo di fondazione e posa dei ferri'),
           ('2026-11-05', 'submitted', 'Nuvoloso', 'Getto delle fondazioni'),
           ('2026-11-06', 'draft', 'Pioggia', 'Disarmo e pulizia del cantiere')
         ) as r (day, status, weather, work_done)
         where s.company_id = $1 and s.code = '2026-01'`,
        [companyId],
      )
      await client.query(
        `insert into public.daily_report_labor (company_id, report_id, employee_id, hours, position)
         select $1, r.id, e.id, 8, row_number() over (partition by r.id order by e.last_name)
         from public.daily_reports r
         join public.employees e on e.company_id = r.company_id and e.active
         where r.company_id = $1
           -- Nobody away the whole day works, as createDailyReport wants.
           and not exists (select 1 from public.employee_absences a
             where a.employee_id = e.id and a.hours is null
               and r.report_date between a.starts_on and a.ends_on)`,
        [companyId],
      )
      await client.query(
        `insert into public.daily_report_vehicles (company_id, report_id, vehicle_id, hours, position)
         select $1, r.id, v.id, 4, 0
         from public.daily_reports r
         join public.vehicles v on v.company_id = r.company_id and v.kind = 'machine'
         where r.company_id = $1 and r.status <> 'draft'`,
        [companyId],
      )
      await client.query(
        `insert into public.site_costs (company_id, site_id, cost_date, category, description,
           supplier_id, amount_cents)
         select $1, s.id, k.day::date, k.category, k.description,
           (select p.id from public.suppliers p where p.company_id = $1 order by p.name limit 1),
           k.cents
         from public.sites s, (values
           ('2026-11-03', 'materials', 'Calcestruzzo C25/30, 12 m³', 156000),
           ('2026-11-04', 'rentals', 'Nolo autopompa per il getto', 48000),
           ('2026-11-05', 'other', 'Smaltimento terre di scavo', 32050)
         ) as k (day, category, description, cents)
         where s.company_id = $1 and s.code = '2026-01'`,
        [companyId],
      )
      // Two purchase orders of the first site: one sent, one still a draft.
      for (const [seq, status, day, lines] of [
        [
          1,
          'sent',
          '2026-11-02',
          [
            ['Calcestruzzo C25/30', 'm³', '12', 13000],
            ['Pompaggio', 'h', '3', 9000],
          ],
        ],
        [2, 'draft', '2026-11-05', [['Rete elettrosaldata 20×20 Ø8', 'm²', '150', 450]]],
      ] as const) {
        await client.query(
          `with o as (
             insert into public.purchase_orders (company_id, number_year, number_seq, supplier_id,
               site_id, order_date, status, sent_at)
             select $1, 2026, $2, (select p.id from public.suppliers p where p.company_id = $1
                 order by p.name limit 1),
               s.id, $3::date, $4, case when $4 = 'sent' then $3::date + time '09:00' end
             from public.sites s where s.company_id = $1 and s.code = '2026-01'
             returning id
           )
           insert into public.purchase_order_lines (company_id, order_id, position, description,
             unit, quantity, unit_price_cents)
           select $1, o.id, l.position - 1, l.description, l.unit, l.quantity, l.cents
           from o, unnest($5::text[], $6::text[], $7::numeric[], $8::bigint[])
             with ordinality as l (description, unit, quantity, cents, position)`,
          [
            companyId,
            seq,
            day,
            status,
            lines.map((l) => l[0]),
            lines.map((l) => l[1]),
            lines.map((l) => l[2]),
            lines.map((l) => l[3]),
          ],
        )
      }
      // Invoices relative to today: one to collect, one overdue, one to pay and one paid,
      // with their payment deadlines in the calendar, as the API does when they are saved.
      await client.query(
        `with c as (
           select id from public.clients where company_id = $1 and archived_at is null
           order by created_at limit 1
         ), p as (
           select id from public.suppliers where company_id = $1 order by created_at limit 1
         ), s as (
           select id from public.sites where company_id = $1 and code = '2026-01'
         )
         insert into public.invoices (company_id, direction, number, invoice_date, client_id,
           supplier_id, site_id, description, taxable_cents, vat_cents, due_date, paid_on,
           vat_nature, withholding_cents, split_payment)
         select $1, i.direction, i.number || '/' || extract(year from current_date + i.days),
           current_date + i.days,
           case when i.direction = 'issued' then (select id from c) end,
           case when i.direction = 'received' then (select id from p) end,
           (select id from s), i.description, i.taxable, i.vat, current_date + i.due,
           case when i.paid then current_date + i.days + 10 end, i.nature, i.withholding,
           i.split
         from (values
           ('issued', '1', -40, 'Primo SAL', 2000000::bigint, 440000::bigint, 20, false,
             null::text, 0::bigint, false),
           ('issued', '2', -70, 'Acconto lavori', 800000::bigint, 176000::bigint, -10, false,
             null, 0, false),
           ('received', 'F-118', -22, 'Calcestruzzo e pompaggio', 602459::bigint,
             132541::bigint, 8, false, null, 0, false),
           ('received', 'F-097', -60, 'Nolo ponteggio', 150000::bigint, 33000::bigint, 0, true,
             null, 0, false),
           ('received', 'S-12', -15, 'Subappalto impianto elettrico, primo acconto',
             450000::bigint, 0::bigint, 15, false, 'N6.3', 0, false),
           -- A professional's fee: 20% withholding tax on the taxable amount.
           ('received', 'P-7', -30, 'Pratica edilizia e calcoli strutturali', 300000::bigint,
             66000::bigint, 0, false, null, 60000, false),
           -- Works for a public administration: split payment, the VAT goes to the treasury.
           ('issued', '3', -5, 'Manutenzione straordinaria scuola comunale', 1200000::bigint,
             264000::bigint, 25, false, null, 0, true)
         ) as i (direction, number, days, description, taxable, vat, due, paid, nature,
           withholding, split)
         where exists (select 1 from c) and exists (select 1 from p)`,
        [companyId],
      )
      // The concrete invoice bills the sent concrete order, when it is of the same supplier.
      await client.query(
        `update public.invoices i set purchase_order_id = o.id
         from public.purchase_orders o
         where i.company_id = $1 and i.direction = 'received' and i.number like 'F-118/%'
           and o.company_id = $1 and o.number_seq = 1 and o.status <> 'draft'
           and o.supplier_id = i.supplier_id`,
        [companyId],
      )
      // The overdue advance invoice is partly collected: a 5,000 euro transfer.
      await client.query(
        `insert into public.invoice_payments
           (company_id, invoice_id, payment_date, amount_cents, method, notes)
         select $1, i.id, i.invoice_date + 30, 500000, 'bank_transfer', 'Primo acconto'
         from public.invoices i where i.company_id = $1 and i.number like '2/%'
           and i.direction = 'issued'`,
        [companyId],
      )
      // A credit note: a 5,000 euro discount granted on the first SAL invoice, after a delay.
      await client.query(
        `insert into public.invoices (company_id, direction, number, invoice_date, client_id,
           site_id, description, taxable_cents, vat_cents, document_type, credited_invoice_id)
         select $1, 'issued', 'NC-1/' || i.number_year, i.invoice_date + 15, i.client_id,
           i.site_id, 'Sconto per ritardo nella consegna', 500000, 110000, 'credit_note', i.id
         from public.invoices i where i.company_id = $1 and i.number like '1/%'
           and i.direction = 'issued'`,
        [companyId],
      )
      await client.query(
        `insert into public.deadlines (company_id, title, due_on, kind, amount_cents, client_id,
           supplier_id, status, done_at, invoice_id)
         select i.company_id, 'Fattura ' || i.number || ' – ' || coalesce(c.name, p.name),
           i.due_date, case i.direction when 'issued' then 'invoice_out' else 'invoice_in' end,
           i.taxable_cents + i.vat_cents - i.withholding_cents
             - case when i.split_payment then i.vat_cents else 0 end
             - case when i.paid_on is null then (select coalesce(sum(ip.amount_cents), 0)
                 from public.invoice_payments ip where ip.invoice_id = i.id) else 0 end
             - case when i.paid_on is null then (select coalesce(sum(n.taxable_cents
                 + n.vat_cents), 0) from public.invoices n where n.credited_invoice_id = i.id)
               else 0 end,
           i.client_id, i.supplier_id,
           case when i.paid_on is null then 'open' else 'done' end,
           case when i.paid_on is not null then now() end, i.id
         from public.invoices i
         left join public.clients c on c.id = i.client_id
         left join public.suppliers p on p.id = i.supplier_id
         where i.company_id = $1 and i.due_date is not null`,
        [companyId],
      )
      // The received concrete invoice comes with its (tiny, made-up) PDF.
      const invoicePdf = Buffer.from('%PDF-1.4\n% fattura di prova\n%%EOF\n')
      await client.query(
        `insert into public.invoice_files
           (invoice_id, company_id, file_name, content_type, size_bytes, data)
         select i.id, $1, 'fattura-F-118.pdf', 'application/pdf', $2, $3
         from public.invoices i where i.company_id = $1 and i.number like 'F-118/%'`,
        [companyId, invoicePdf.length, invoicePdf],
      )
      // A few warehouse items: loaded on 2 November, part taken to the first site. The planks
      // are below their minimum stock, to reorder; five sacks of cement came back from the site.
      await client.query(
        `with i as (
           insert into public.warehouse_items (company_id, code, name, unit, min_stock)
           values ($1, 'CEM-325', 'Cemento 32.5 in sacchi da 25 kg', 'sacchi', 50),
             ($1, 'SAB-02', 'Sabbia lavata 0-2 mm', 'm³', null),
             ($1, 'TAV-50', 'Tavole da ponte 4 m', 'pz', 80)
           returning id, code
         )
         insert into public.warehouse_movements (company_id, item_id, movement_date, kind,
           quantity, site_id, unit_cost_cents, site_return)
         select $1, i.id, m.day::date, m.kind, m.quantity::numeric,
           case when m.kind = 'out' or m.back then (select s.id from public.sites s
             where s.company_id = $1 and s.code = '2026-01') end,
           m.cost::bigint, m.back
         from i join (values
           ('CEM-325', '2026-11-02', 'in', '200', '650', false),
           ('CEM-325', '2026-11-04', 'out', '40', null, false),
           ('CEM-325', '2026-11-06', 'in', '5', null, true),
           ('SAB-02', '2026-11-02', 'in', '12', '3800', false),
           ('TAV-50', '2026-11-02', 'in', '60', null, false)
         ) as m (code, day, kind, quantity, cost, back) on m.code = i.code`,
        [companyId],
      )
      // A document and a photo on the first site, so the archive is not empty; the photo
      // belongs to the latest daily report of the site.
      for (const file of DEV_FILES) {
        await client.query(
          `with d as (
             insert into public.site_documents (company_id, site_id, daily_report_id, kind, title,
               file_name, content_type, size_bytes)
             select $1, s.id, case when $2 = 'photo' then (
                 select r.id from public.daily_reports r where r.site_id = s.id
                 order by r.report_date desc limit 1) end,
               $2, $3, $4, $5, $6 from public.sites s
             where s.company_id = $1 and s.code = '2026-01'
             returning id
           )
           insert into public.site_document_files (document_id, company_id, data)
           select d.id, $1, $7 from d`,
          [companyId, file.kind, file.title, file.name, file.type, file.data.length, file.data],
        )
      }
      // Schedule of the first site: a chain of activities for the Gantt chart.
      await client.query(
        `insert into public.site_activities (company_id, site_id, name, start_on, end_on, progress)
         select $1, s.id, a.name, a.start_on::date, a.end_on::date, a.progress
         from public.sites s, (values
           ('Allestimento del cantiere', '2026-10-05', '2026-10-07', 100),
           ('Scavi', '2026-10-08', '2026-10-16', 100),
           ('Fondazioni', '2026-10-19', '2026-11-06', 70),
           ('Murature', '2026-11-09', '2026-12-04', 0)
         ) as a (name, start_on, end_on, progress)
         where s.company_id = $1 and s.code = '2026-01'`,
        [companyId],
      )
      await client.query(
        `insert into public.site_activity_dependencies (company_id, site_id, activity_id,
           depends_on_id)
         select $1, a.site_id, a.id, p.id
         from public.site_activities a
         join public.site_activities p on p.site_id = a.site_id and p.start_on = (
           select max(q.start_on) from public.site_activities q
           where q.site_id = a.site_id and q.start_on < a.start_on
         )
         where a.company_id = $1`,
        [companyId],
      )
      await client.query('delete from public.price_lists where company_id = $1', [companyId])
      await client.query(
        `with l as (
           insert into public.price_lists (company_id, name, year)
           values ($1, 'Prezzi interni', 2026) returning id
         )
         insert into public.price_list_items (company_id, price_list_id, code, description, unit,
           unit_price_cents)
         select $1, l.id, i.code, i.description, i.unit, i.cents
         from l, (values
           ('SC.01', 'Scavo di sbancamento con mezzo meccanico', 'm³', 850),
           ('CLS.01', 'Calcestruzzo C25/30 per fondazioni, in opera', 'm³', 14500),
           ('MUR.01', 'Muratura in blocchi di laterizio da 30 cm', 'm²', 6200),
           ('INT.01', 'Intonaco civile per interni', 'm²', 2300)
         ) as i (code, description, unit, cents)`,
        [companyId],
      )
      // Progress statements keep their estimate: they go first.
      await client.query('delete from public.progress_statements where company_id = $1', [
        companyId,
      ])
      await client.query('delete from public.estimates where company_id = $1', [companyId])
      await client.query(
        `insert into public.estimates (company_id, title, client_id, site_id, site_address, status)
         select $1, e.title, c.id,
           (select s.id from public.sites s where s.company_id = $1 and s.code = '2026-01'
            and e.n = 0),
           e.address, e.status
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
      // Progress statements of the bathroom: the first approved at half of each item, the
      // second still a draft.
      await client.query(
        `with e as (
           select id from public.estimates
           where company_id = $1 and title = 'Ristrutturazione bagno'
         ), s as (
           insert into public.progress_statements (company_id, estimate_id, number,
             statement_date, status, approved_at, retention_percent)
           select $1, e.id, v.number, v.day::date, v.status,
             case when v.status = 'approved' then now() end, 5
           from e, (values (1, '2026-10-31', 'approved'), (2, '2026-11-30', 'draft'))
             as v (number, day, status)
           returning id, estimate_id, number
         )
         insert into public.progress_statement_lines (company_id, estimate_id, statement_id,
           item_id, quantity, unit_price_cents)
         select $1, s.estimate_id, s.id, t.item_id,
           round(t.quantity * case when s.number = 1 then 0.5 else 0.25 end, 3),
           i.unit_price_cents
         from s
         join public.estimate_item_totals t on t.estimate_id = s.estimate_id
         join public.estimate_items i on i.id = t.item_id
         where t.quantity > 0`,
        [companyId],
      )
      // The first issued invoice bills the approved SAL n. 1, on the site of its estimate.
      await client.query(
        `update public.invoices i set progress_statement_id = ps.id, site_id = e.site_id
         from public.progress_statements ps
         join public.estimates e on e.id = ps.estimate_id
         where i.company_id = $1 and i.direction = 'issued' and i.number like '1/%'
           and ps.company_id = $1 and ps.status = 'approved'
           and e.title = 'Ristrutturazione bagno'`,
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
    // A pending invitation with a known link, for the page /invito/:token.
    await client.query(
      `delete from public.invitations
       where company_id = $1 and email = $2 and accepted_at is null and token_hash <> $3`,
      [companyIds['impresa-rossi'], 'nuovo.collega@example.test', sha256(DEV_INVITATION_TOKEN)],
    )
    await client.query(
      `insert into public.invitations (company_id, email, role_id, token_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '7 days')
       on conflict (token_hash) do update set expires_at = excluded.expires_at,
         accepted_at = null, accepted_user_id = null`,
      [
        companyIds['impresa-rossi'],
        'nuovo.collega@example.test',
        roleIds['impresa-rossi/Ufficio'],
        sha256(DEV_INVITATION_TOKEN),
      ],
    )
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
      console.log(`  invitation: /invito/${DEV_INVITATION_TOKEN}`)
      console.log(`  companies: ${COMPANIES.map((c) => c.slug).join(', ')}`)
    })
    .catch((error: unknown) => {
      console.error(`✗ ${(error as Error).message}`)
      process.exit(1)
    })
}
