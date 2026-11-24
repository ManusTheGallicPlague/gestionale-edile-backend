/**
 * The Brevo mailer against a local HTTP server that stands in for Brevo, and the choice of
 * the mailer from the configuration.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { BrevoMailer, LogMailer, MailNotSent, createMailer } from '../src/mail/mailer.js'

interface Received {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: unknown
}

let server: Server
let endpoint: string
const received: Received[] = []
/** What the fake Brevo does with the next request. */
let answer: 'ok' | 'refuse' | 'hang' = 'ok'

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(raw) as unknown,
      })
      if (answer === 'hang') return
      res.writeHead(answer === 'ok' ? 201 : 401, { 'content-type': 'application/json' })
      res.end(
        answer === 'ok'
          ? JSON.stringify({ messageId: '<prova@example.test>' })
          : JSON.stringify({ code: 'unauthorized', message: 'Key not found' }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/smtp/email`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const message = { to: 'mario@example.test', subject: 'Prova', text: 'Ciao Mario,\n\nprova.\n' }

function mailer(timeoutMs?: number) {
  return new BrevoMailer({
    apiKey: 'chiave-di-prova',
    sender: { email: 'gestionale@example.test', name: 'Gestionale' },
    endpoint,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

describe('Brevo mailer', () => {
  it('posts the message as JSON with the API key in the header', async () => {
    answer = 'ok'
    received.length = 0
    await mailer().send(message)
    expect(received).toHaveLength(1)
    const [request] = received
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/v3/smtp/email')
    expect(request?.headers['api-key']).toBe('chiave-di-prova')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.body).toEqual({
      sender: { email: 'gestionale@example.test', name: 'Gestionale' },
      to: [{ email: 'mario@example.test' }],
      subject: 'Prova',
      textContent: 'Ciao Mario,\n\nprova.\n',
    })
  })

  it('leaves the sender name out when there is none', async () => {
    answer = 'ok'
    received.length = 0
    await new BrevoMailer({
      apiKey: 'chiave-di-prova',
      sender: { email: 'gestionale@example.test' },
      endpoint,
    }).send(message)
    expect((received[0]?.body as { sender: unknown }).sender).toEqual({
      email: 'gestionale@example.test',
    })
  })

  it('rejects with the status and the answer when Brevo refuses the message', async () => {
    answer = 'refuse'
    const error = await mailer()
      .send(message)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailNotSent)
    expect((error as Error).message).toContain('401')
    expect((error as Error).message).toContain('Key not found')
    expect((error as Error).message).not.toContain('chiave-di-prova')
  })

  it('gives up when Brevo does not answer in time', async () => {
    answer = 'hang'
    const started = Date.now()
    await expect(mailer(200).send(message)).rejects.toBeInstanceOf(MailNotSent)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('rejects when Brevo cannot be reached', async () => {
    const unreachable = new BrevoMailer({
      apiKey: 'chiave-di-prova',
      sender: { email: 'gestionale@example.test' },
      endpoint: 'http://127.0.0.1:9/v3/smtp/email',
      timeoutMs: 2_000,
    })
    await expect(unreachable.send(message)).rejects.toBeInstanceOf(MailNotSent)
  })
})

const baseEnv = {
  DATABASE_URL_APP: 'postgres://app@localhost/db',
  DATABASE_URL_AUTH: 'postgres://auth@localhost/db',
  CSRF_SECRET: 'a-secret-that-is-long-enough-for-hmac-0123456789',
}

function fakeLog() {
  const warn = vi.fn()
  const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
  return { log, warn }
}

describe('mail configuration', () => {
  it('uses Brevo when the key is there, with the sender from the environment', () => {
    const config = loadConfig({
      ...baseEnv,
      BREVO_API_KEY: ' chiave ',
      MAIL_FROM: 'gestionale@example.test',
      MAIL_FROM_NAME: 'Impresa di prova',
    })
    expect(config.brevo).toEqual({
      apiKey: 'chiave',
      sender: { email: 'gestionale@example.test', name: 'Impresa di prova' },
    })
    const { log, warn } = fakeLog()
    expect(createMailer(config, log)).toBeInstanceOf(BrevoMailer)
    expect(warn).not.toHaveBeenCalled()
  })

  it('wants a valid sender together with the key', () => {
    expect(() => loadConfig({ ...baseEnv, BREVO_API_KEY: 'chiave' })).toThrow(/MAIL_FROM/)
    expect(() =>
      loadConfig({ ...baseEnv, BREVO_API_KEY: 'chiave', MAIL_FROM: 'non-una-email' }),
    ).toThrow(/MAIL_FROM/)
  })

  it('without the key writes to the log, and warns in production', () => {
    const development: Config = loadConfig(baseEnv)
    expect(development.brevo).toBeNull()
    const quiet = fakeLog()
    expect(createMailer(development, quiet.log)).toBeInstanceOf(LogMailer)
    expect(quiet.warn).not.toHaveBeenCalled()

    const production = loadConfig({ ...baseEnv, COOKIE_SECURE: 'true' })
    const loud = fakeLog()
    expect(createMailer(production, loud.log)).toBeInstanceOf(LogMailer)
    expect(loud.warn).toHaveBeenCalledWith(expect.stringContaining('BREVO_API_KEY'))
  })
})
