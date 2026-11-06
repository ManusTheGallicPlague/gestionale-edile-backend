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
  version: number
  updated_at: Date | null
}

/** The saved profile, or the company name and empty fields (version 0) if never saved. */
export async function readProfile(client: PoolClient): Promise<ProfileRow> {
  const { rows } = await client.query<ProfileRow>(
    `select coalesce(p.legal_name, c.name) as legal_name, p.vat_number, p.tax_code, p.rea,
       p.share_capital_cents::text as share_capital_cents, p.street, p.postal_code, p.city,
       p.province, coalesce(p.country, 'IT') as country, p.phone, p.email, p.pec, p.iban,
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
      return readProfile(client)
    })
    return send(reply, row)
  })
}
