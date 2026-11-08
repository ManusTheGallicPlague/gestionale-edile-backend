import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { centsToAmount } from '../money.js'
import { ApiError, ValidationFailed, forbidden, messages } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { PROFILE_FIELDS, parseProfile, type ProfileInput } from '../settings/input.js'

export interface ProfileRow extends ProfileInput {
  patron_saint_day: string | null
  version: number
  updated_at: Date | null
}

/** The saved profile, or the company name and empty fields (version 0) if never saved. */
export async function readProfile(client: PoolClient): Promise<ProfileRow> {
  const { rows } = await client.query<ProfileRow>(
    `select coalesce(p.legal_name, c.name) as legal_name, p.vat_number, p.tax_code, p.rea,
       p.share_capital_cents::text as share_capital_cents, p.street, p.postal_code, p.city,
       p.province, coalesce(p.country, 'IT') as country, p.phone, p.email, p.pec, p.iban,
       p.patron_saint_day,
       coalesce(p.version, 0) as version, p.updated_at
     from public.companies c
     left join public.company_profiles p on p.company_id = c.id
     where c.id = app.current_company_id()`,
  )
  const row = rows[0]
  if (!row) throw new Error('company not found')
  return row
}

const toContract = (row: ProfileRow) => ({
  legal_name: row.legal_name,
  vat_number: row.vat_number,
  tax_code: row.tax_code,
  rea: row.rea,
  share_capital: row.share_capital_cents === null ? null : centsToAmount(row.share_capital_cents),
  street: row.street,
  postal_code: row.postal_code,
  city: row.city,
  province: row.province,
  country: row.country,
  phone: row.phone,
  email: row.email,
  pec: row.pec,
  iban: row.iban,
  patron_saint_day: row.patron_saint_day,
  updated_at: row.updated_at ? row.updated_at.toISOString() : null,
})

const send = (reply: FastifyReply, row: ProfileRow) =>
  reply.header('ETag', `"${row.version}"`).send(toContract(row))

const placeholders = PROFILE_FIELDS.map((_, i) => `$${i + 1}`).join(', ')
const assignments = PROFILE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')

export function settingsRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const url = '/api/companies/:company/settings/company'

  app.get<{ Params: { company: string } }>(url, async (request, reply) => {
    const session = requireSession(request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('settings.view')) throw forbidden()
      return readProfile(client)
    })
    return send(reply, row)
  })

  app.put<{ Params: { company: string } }>(url, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('settings.update')) throw forbidden()
      const header = request.headers['if-match']
      if (typeof header !== 'string' || header.trim() === '') {
        throw new ApiError(428, messages.settingsMissingIfMatch, 'precondition_required')
      }
      const match = /^"(\d{1,9})"$/.exec(header.trim())
      const version = match ? Number(match[1]) : -1
      const parsed = parseProfile(request.body)
      if ('errors' in parsed) throw new ValidationFailed(parsed.errors)
      const values: unknown[] = PROFILE_FIELDS.map((f) => parsed.input[f])
      // Version 0 means "never saved": only the first save can insert the row.
      const { rowCount } =
        version === 0
          ? await client.query(
              `insert into public.company_profiles (company_id, ${PROFILE_FIELDS.join(', ')})
               values (app.current_company_id(), ${placeholders})
               on conflict (company_id) do nothing`,
              values,
            )
          : await client.query(
              `update public.company_profiles
               set ${assignments}, version = version + 1, updated_at = now()
               where company_id = app.current_company_id() and version = $${values.length + 1}`,
              [...values, version],
            )
      if (!rowCount) throw new ApiError(412, messages.settingsStale, 'stale_record')
      if (parsed.patron !== undefined) {
        await client.query(
          `update public.company_profiles set patron_saint_day = $1
           where company_id = app.current_company_id()`,
          [parsed.patron],
        )
      }
      return readProfile(client)
    })
    return send(reply, row)
  })
}

type Series = 'quotes' | 'purchase_orders'

interface SeriesRow {
  year: number
  quotes_next: number
  quotes_highest: number
  orders_next: number
  orders_highest: number
}

/**
 * Next numbers of a year. Quotes: one after the counter, which only ever grows. Purchase
 * orders: one after the highest of the floor set here and the numbers already used.
 */
async function readNumbering(client: PoolClient, year?: number): Promise<SeriesRow> {
  const { rows } = await client.query<SeriesRow>(
    `select y.year,
       coalesce(k.last_number, 0) + 1 as quotes_next,
       coalesce((select max(number_seq) from public.quotes where number_year = y.year), 0)
         as quotes_highest,
       greatest(coalesce(p.last_number, 0), o.highest) + 1 as orders_next,
       o.highest as orders_highest
     from (select coalesce($1::int,
             extract(year from (now() at time zone 'Europe/Rome'))::int) as year) y
     left join public.quote_counters k on k.year = y.year
     left join public.purchase_order_counters p on p.year = y.year
     cross join lateral (
       select coalesce(max(number_seq), 0) as highest
       from public.purchase_orders where number_year = y.year
     ) o`,
    [year ?? null],
  )
  const row = rows[0]
  if (!row) throw new Error('numbering query returned no row')
  return row
}

const series = (year: number, next: number) => ({
  year,
  next_number: next,
  next: `${year}/${String(next).padStart(3, '0')}`,
})

const numberingToContract = (row: SeriesRow) => ({
  quotes: series(row.year, row.quotes_next),
  purchase_orders: series(row.year, row.orders_next),
})

export function numberingRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const url = '/api/companies/:company/settings/numbering'

  app.get<{ Params: { company: string } }>(url, async (request) => {
    const session = requireSession(request)
    return withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const permissions = await enterCompany(client, request.params.company)
      if (!permissions.has('settings.view')) throw forbidden()
      return numberingToContract(await readNumbering(client))
    })
  })

  const setter = (path: string, which: Series) =>
    app.put<{ Params: { company: string } }>(`${url}/${path}`, async (request) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('settings.update')) throw forbidden()
        const body = request.body as Record<string, unknown> | null
        const current = (await readNumbering(client)).year
        const year = body?.year
        const next = body?.next_number
        const errors: Record<string, string[]> = {}
        if (typeof year !== 'number' || !Number.isInteger(year) || Math.abs(year - current) > 1) {
          errors.year = [
            `L'anno corrente, il precedente o il successivo (${current - 1}–${current + 1}).`,
          ]
        }
        if (typeof next !== 'number' || !Number.isInteger(next) || next < 1 || next > 999999) {
          errors.next_number = ['Un numero intero da 1 a 999999.']
        }
        if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
        const y = year as number
        const n = next as number
        if (which === 'quotes') {
          // The counter row is locked as a send would lock it: no quote takes a number meanwhile.
          await client.query(
            `insert into public.quote_counters (company_id, year, last_number)
             values (app.current_company_id(), $1, 0)
             on conflict (company_id, year) do update set last_number = public.quote_counters.last_number`,
            [y],
          )
        } else {
          // The same lock as an order creation: no order takes a number meanwhile.
          await client.query(
            `select pg_advisory_xact_lock(hashtext('purchase_orders:' || app.current_company_id()))`,
          )
        }
        const before = await readNumbering(client, y)
        const highest = which === 'quotes' ? before.quotes_highest : before.orders_highest
        if (n <= highest) {
          throw new ApiError(409, messages.numberInUse(highest), 'number_in_use')
        }
        await client.query(
          which === 'quotes'
            ? `update public.quote_counters set last_number = $2
               where company_id = app.current_company_id() and year = $1`
            : `insert into public.purchase_order_counters (company_id, year, last_number)
               values (app.current_company_id(), $1, $2)
               on conflict (company_id, year) do update set last_number = excluded.last_number`,
          [y, n - 1],
        )
        return numberingToContract(await readNumbering(client, y))
      })
    })

  setter('quotes', 'quotes')
  setter('purchase-orders', 'purchase_orders')
}
