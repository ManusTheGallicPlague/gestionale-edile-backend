export interface Config {
  host: string
  port: number
  databaseUrlApp: string
  databaseUrlAuth: string
  csrfSecret: string
  cookieSecure: boolean
  trustProxy: boolean
  logLevel: string
  loginLimits: LoginLimits
  /** Public address of the frontend, for the links in emails (no trailing slash). */
  appUrl: string
}

export interface LoginLimits {
  windowSeconds: number
  maxFailuresPerEmail: number
  maxFailuresPerIp: number
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  windowSeconds: 15 * 60,
  maxFailuresPerEmail: 5,
  maxFailuresPerIp: 30,
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name} (see .env.example)`)
  return value
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]
  if (value === undefined || value === '') return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const csrfSecret = required(env, 'CSRF_SECRET')
  if (csrfSecret.length < 32 || csrfSecret.startsWith('CHANGE_ME')) {
    throw new Error('CSRF_SECRET must be at least 32 random characters')
  }
  const port = Number(env.PORT ?? '3100')
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer')

  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrlApp: required(env, 'DATABASE_URL_APP'),
    databaseUrlAuth: required(env, 'DATABASE_URL_AUTH'),
    csrfSecret,
    cookieSecure: flag(env, 'COOKIE_SECURE'),
    trustProxy: flag(env, 'TRUST_PROXY'),
    logLevel: env.LOG_LEVEL ?? 'info',
    loginLimits: DEFAULT_LOGIN_LIMITS,
    appUrl: appUrl(env),
  }
}

function appUrl(env: NodeJS.ProcessEnv): string {
  const value = (env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+$/.test(value)) {
    throw new Error('APP_URL must be like https://gestionale.example.test, without a path')
  }
  return value
}
