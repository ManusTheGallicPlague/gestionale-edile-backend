import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Response as InjectResponse } from 'light-my-request'
import pg from 'pg'
import { inject } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { DEFAULT_LOGIN_LIMITS, type Config } from '../src/config.js'
import { createDb, type Db } from '../src/db.js'
import type { Permission } from '../src/permissions.js'
import { expectContract } from './contract.js'
import { MemoryMailer } from '../src/mail/mailer.js'

export const PASSWORD = 'password-di-prova'
let hashed: Promise<string> | undefined

export interface TestContext {
  app: FastifyInstance
  db: Db
  owner: pg.Pool
  config: Config
  mailer: MemoryMailer
  close(): Promise<void>
}

export async function startApp(): Promise<TestContext> {
  const urls = inject('testDb')
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    databaseUrlApp: urls.app,
    databaseUrlAuth: urls.auth,
    csrfSecret: 'test-secret-that-is-long-enough-for-hmac-0123456789',
    cookieSecure: false,
    trustProxy: false,
    logLevel: 'silent',
    loginLimits: DEFAULT_LOGIN_LIMITS,
    appUrl: 'https://gestionale.example.test',
  }
  const db = createDb({ app: urls.app, auth: urls.auth })
  const owner = new pg.Pool({ connectionString: urls.owner, max: 3 })
  const mailer = new MemoryMailer()
  const app = buildApp(config, db, { logger: false, mailer })
  await app.ready()
  return {
    app,
    db,
    owner,
    config,
    mailer,
    async close() {
      await app.close()
      await db.close()
      await owner.end()
    },
  }
}

export const unique = () => randomUUID().slice(0, 8)

/** Creates data as the owner, bypassing the API: it is how tests set the scene. */
export class Fixtures {
  constructor(private readonly owner: pg.Pool) {}

  async company(name = 'Impresa di prova') {
    const slug = `impresa-${unique()}`
    const { rows } = await this.owner.query<{ id: string }>(
      'insert into public.companies (slug, name) values ($1, $2) returning id',
      [slug, name],
    )
    return { id: rows[0]?.id ?? '', slug, name }
  }

  async role(companyId: string, name: string, permissions: Permission[]) {
    const { rows } = await this.owner.query<{ id: string }>(
      'insert into public.roles (company_id, name) values ($1, $2) returning id',
      [companyId, name],
    )
    const id = rows[0]?.id ?? ''
    for (const permission of permissions) {
      await this.owner.query('insert into public.role_permissions values ($1, $2)', [
        id,
        permission,
      ])
    }
    return id
  }

  async user(options: { active?: boolean; name?: string } = {}) {
    hashed ??= hashPassword(PASSWORD)
    const email = `utente-${unique()}@example.test`
    const name = options.name ?? 'Utente di prova'
    const { rows } = await this.owner.query<{ id: string }>(
      'insert into auth.users (email, name, password_hash, active) values ($1, $2, $3, $4) returning id',
      [email, name, await hashed, options.active ?? true],
    )
    return { id: rows[0]?.id ?? '', email, name }
  }

  async member(userId: string, companyId: string, roleId: string) {
    await this.owner.query(
      'insert into public.memberships (user_id, company_id, role_id) values ($1, $2, $3)',
      [userId, companyId, roleId],
    )
  }

  /** A company with one user holding the given permissions. */
  async companyWithUser(permissions: Permission[], roleName = 'Titolare') {
    const company = await this.company()
    const roleId = await this.role(company.id, roleName, permissions)
    const user = await this.user()
    await this.member(user.id, company.id, roleId)
    return { company, user, roleId }
  }
}

/**
 * A browser in miniature: keeps cookies between requests and, like the frontend's client,
 * copies XSRF-TOKEN into X-XSRF-TOKEN on requests that change data.
 */
export class Browser {
  readonly cookies = new Map<string, string>()
  private static counter = 0
  readonly ip: string

  constructor(private readonly app: FastifyInstance) {
    Browser.counter++
    this.ip = `10.0.${Math.floor(Browser.counter / 250)}.${(Browser.counter % 250) + 1}`
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<InjectResponse> {
    const headers: Record<string, string> = { ...options.headers }
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    const token = this.cookies.get('XSRF-TOKEN')
    if (method !== 'GET' && options.csrf !== false && token && !('x-xsrf-token' in headers)) {
      headers['x-xsrf-token'] = decodeURIComponent(token)
    }
    const res = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    })
    for (const c of res.cookies as {
      name: string
      value: string
      expires?: Date
      maxAge?: number
    }[]) {
      const expired =
        c.maxAge === 0 || (c.expires !== undefined && c.expires.getTime() < Date.now())
      if (expired || c.value === '') this.cookies.delete(c.name)
      else this.cookies.set(c.name, c.value)
    }
    return res
  }

  /** Request plus contract check. */
  async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ) {
    const res = await this.request(method, url, options)
    expectContract(res, method, url)
    return res
  }

  async signIn(email: string, password = PASSWORD) {
    await this.request('GET', '/api/auth/csrf')
    const res = await this.call('POST', '/api/auth/login', { body: { email, password } })
    if (res.statusCode !== 204) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`)
    return res
  }
}

/** A valid client body, ready for POST or PUT. */
export function clientBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'company',
    name: 'Edil Prova S.r.l.',
    vat_number: '01234567897',
    tax_code: null,
    email: 'info@edilprova.example.test',
    pec: null,
    phone: '011 555 1234',
    sdi_code: 'ABC1234',
    street: 'Via Roma 1',
    postal_code: '10121',
    city: 'Torino',
    province: 'TO',
    country: 'IT',
    notes: null,
    ...overrides,
  }
}
