import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { randomToken, sha256 } from '../auth/crypto.js'
import { recordFailure, secondsUntilAllowed, clearFailures } from '../auth/login-limits.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { UUID } from '../deadlines/input.js'
import { ApiError, ValidationFailed, forbidden, messages, notFound } from '../http/errors.js'
import type { FieldErrors } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { startSession } from './auth.js'

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MIN_PASSWORD_LENGTH = 10

const INVALID_INVITATION = 'Invito non valido, già usato o scaduto: chiedi un nuovo invito.'
const ALREADY_MEMBER_INVITE = 'Questa persona fa già parte dell’azienda.'
const ALREADY_MEMBER_ACCEPT = 'Fai già parte di questa azienda: accedi con la tua password.'
const WRONG_PASSWORD = 'Password non corretta.'

interface InvitationRow {
  id: string
  email: string
  role_id: string
  role_name: string
  expires_at: Date
  created_at: Date
}

const COLUMNS = `i.id, i.email, i.role_id, r.name as role_name, i.expires_at, i.created_at`

function present(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    role: { id: row.role_id, name: row.role_name },
    status: row.expires_at.getTime() > Date.now() ? 'pending' : 'expired',
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  }
}

function asObject(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

function readInvitation(body: unknown): { email: string; roleId: string } {
  const raw = asObject(body)
  const errors: FieldErrors = {}
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : ''
  const roleId = typeof raw.role_id === 'string' ? raw.role_id : ''
  if (!email) errors.email = ["Inserisci l'email."]
  else if (email.length > 254 || !EMAIL.test(email)) {
    errors.email = ["L'indirizzo email non sembra valido."]
  }
  if (!roleId) errors.role_id = ['Scegli il ruolo.']
  else if (!UUID.test(roleId)) errors.role_id = ['Ruolo non trovato.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { email, roleId }
}

function readAccept(body: unknown): { name: string | null; password: string } {
  const raw = asObject(body)
  const errors: FieldErrors = {}
  const name = typeof raw.name === 'string' ? raw.name.trim() : null
  const password = typeof raw.password === 'string' ? raw.password : ''
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') {
    errors.name = ['Il nome deve essere un testo.']
  } else if (name !== null && name.length > 200) errors.name = ['Al massimo 200 caratteri.']
  if (!password) errors.password = ['Inserisci la password.']
  else if (password.length > 200) errors.password = ['Al massimo 200 caratteri.']
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return { name: name === '' ? null : name, password }
}

export function invitationRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get<{ Params: { company: string } }>(
    '/api/companies/:company/invitations',
    async (request) => {
      const session = requireSession(request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('users.manage')) throw forbidden()
        const { rows } = await client.query<InvitationRow>(
          `select ${COLUMNS}
           from public.invitations i join public.roles r on r.id = i.role_id
           where i.company_id = app.current_company_id() and i.accepted_at is null
           order by i.created_at desc, i.id`,
        )
        return { data: rows.map(present) }
      })
    },
  )

  app.post<{ Params: { company: string } }>(
    '/api/companies/:company/invitations',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('users.manage')) throw forbidden()
        const input = readInvitation(request.body)
        const role = await client.query(
          'select 1 from public.roles where id = $1 and company_id = app.current_company_id()',
          [input.roleId],
        )
        if (role.rowCount === 0) throw new ValidationFailed({ role_id: ['Ruolo non trovato.'] })
        const member = await client.query<{ member: boolean }>(
          'select app.is_company_member($1) as member',
          [input.email],
        )
        if (member.rows[0]?.member) throw new ApiError(409, ALREADY_MEMBER_INVITE, 'already_member')

        // A new invitation replaces the pending one: the old link stops working.
        await client.query(
          `delete from public.invitations
           where company_id = app.current_company_id() and email = $1 and accepted_at is null`,
          [input.email],
        )
        const token = randomToken()
        const { rows } = await client.query<InvitationRow>(
          `with i as (
             insert into public.invitations (company_id, email, role_id, token_hash, expires_at)
             values (app.current_company_id(), $1, $2, $3, now() + interval '7 days')
             returning id, email, role_id, expires_at, created_at
           )
           select ${COLUMNS} from i join public.roles r on r.id = i.role_id`,
          [input.email, input.roleId, sha256(token)],
        )
        const row = rows[0]
        if (!row) throw new Error('invitation not created')
        return reply.code(201).send({ ...present(row), token })
      })
    },
  )

  app.delete<{ Params: { company: string; invitation: string } }>(
    '/api/companies/:company/invitations/:invitation',
    async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      return withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('users.manage')) throw forbidden()
        if (!UUID.test(request.params.invitation)) throw notFound()
        const { rowCount } = await client.query(
          `delete from public.invitations
           where id = $1 and company_id = app.current_company_id() and accepted_at is null`,
          [request.params.invitation],
        )
        if (rowCount === 0) throw notFound()
        return reply.code(204).send()
      })
    },
  )

  app.get<{ Params: { token: string } }>('/api/invitations/:token', async (request) => {
    const invitation = await findByToken(db, request.params.token)
    return {
      company_name: invitation.company_name,
      email: invitation.email,
      role_name: invitation.role_name,
      expires_at: invitation.expires_at.toISOString(),
      account_exists: invitation.user_id !== null,
    }
  })

  app.post<{ Params: { token: string } }>(
    '/api/invitations/:token/accept',
    async (request, reply) => {
      checkCsrf(config, request)
      const input = readAccept(request.body)
      const invitation = await findByToken(db, request.params.token)
      const tokenHash = sha256(request.params.token)

      let passwordHash: string | null = null
      if (invitation.user_id !== null) {
        // An existing account proves itself with its password, under the sign-in limits.
        const wait = await secondsUntilAllowed(
          db.auth,
          config.loginLimits,
          invitation.email,
          request.ip,
        )
        if (wait !== null) {
          throw new ApiError(429, messages.tooManyAttempts, undefined, {
            'Retry-After': String(wait),
          })
        }
        const ok = await verifyPassword(invitation.user_password_hash, input.password)
        if (!ok || !invitation.user_active) {
          await recordFailure(db.auth, invitation.email, request.ip)
          throw new ValidationFailed({ password: [WRONG_PASSWORD] }, 'Accesso non riuscito.')
        }
        await clearFailures(db.auth, invitation.email)
      } else {
        const errors: FieldErrors = {}
        if (input.name === null) errors.name = ['Inserisci nome e cognome.']
        if (input.password.length < MIN_PASSWORD_LENGTH) {
          errors.password = [`Almeno ${MIN_PASSWORD_LENGTH} caratteri.`]
        }
        if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
        passwordHash = await hashPassword(input.password)
      }

      const { rows } = await db.auth.query<{ outcome: string; user_id: string | null }>(
        'select * from auth.accept_invitation($1, $2, $3, $4)',
        [tokenHash, invitation.user_id, input.name, passwordHash],
      )
      const result = rows[0]
      if (result?.outcome === 'already_member') {
        throw new ApiError(409, ALREADY_MEMBER_ACCEPT, 'already_member')
      }
      if (result?.outcome !== 'ok' || !result.user_id) {
        throw new ApiError(404, INVALID_INVITATION)
      }
      await startSession(config, db, request, reply, result.user_id)
      return reply.code(204).send()
    },
  )
}

async function findByToken(db: Db, token: string) {
  if (!TOKEN.test(token)) throw new ApiError(404, INVALID_INVITATION)
  const { rows } = await db.auth.query<{
    id: string
    company_name: string
    email: string
    role_name: string
    expires_at: Date
    user_id: string | null
    user_password_hash: string | null
    user_active: boolean | null
  }>('select * from auth.invitation_by_token($1)', [sha256(token)])
  const row = rows[0]
  if (!row) throw new ApiError(404, INVALID_INVITATION)
  return row
}
