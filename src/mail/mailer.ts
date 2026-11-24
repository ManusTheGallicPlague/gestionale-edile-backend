import type { FastifyBaseLogger } from 'fastify'
import type { BrevoConfig, Config } from '../config.js'
import { ApiError, messages } from '../http/errors.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

/**
 * Sends email. The API only depends on this interface: a real provider (SMTP or an HTTP
 * service) plugs in here without touching the routes. `send` rejects when the message did
 * not leave.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** For development: the message ends up in the log, link included. Never for production. */
export class LogMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  send(message: MailMessage): Promise<void> {
    this.log.info({ mail: message }, `email per ${message.to}: ${message.subject}`)
    return Promise.resolve()
  }
}

/**
 * For tests: keeps the messages in memory. `refuses` makes it reject some of them, like a
 * provider that is down.
 */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []
  refuses: (message: MailMessage) => boolean = () => false

  send(message: MailMessage): Promise<void> {
    if (this.refuses(message)) return Promise.reject(new MailNotSent('rifiutata dal test'))
    this.sent.push(message)
    return Promise.resolve()
  }
}

export class MailNotSent extends Error {}

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email'

export interface BrevoMailerOptions extends BrevoConfig {
  /** How long to wait for Brevo's answer before giving up. */
  timeoutMs?: number
  endpoint?: string
  fetch?: typeof fetch
}

/** Brevo's transactional email API: https://developers.brevo.com/reference/sendtransacemail */
export class BrevoMailer implements Mailer {
  private readonly timeoutMs: number
  private readonly endpoint: string
  private readonly fetch: typeof fetch

  constructor(private readonly options: BrevoMailerOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.endpoint = options.endpoint ?? BREVO_ENDPOINT
    this.fetch = options.fetch ?? fetch
  }

  async send(message: MailMessage): Promise<void> {
    const { sender } = this.options
    let response: Response
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': this.options.apiKey,
        },
        body: JSON.stringify({
          sender: sender.name
            ? { email: sender.email, name: sender.name }
            : { email: sender.email },
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new MailNotSent(`Brevo non risponde: ${(error as Error).message}`, { cause: error })
    }
    // The body is read in both cases, so that the connection goes back to the pool.
    const body = await response.text().catch(() => '')
    if (!response.ok) {
      throw new MailNotSent(`Brevo ha risposto ${response.status}: ${body.slice(0, 500)}`)
    }
  }
}

/** Brevo when configured, otherwise the log. In production the log is never what you want. */
export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  if (config.brevo) return new BrevoMailer(config.brevo)
  if (config.cookieSecure) {
    log.warn(
      'BREVO_API_KEY non impostata: le email (inviti, password dimenticata, cambio email) ' +
        'finiscono solo nel log e non arrivano a nessuno. Vedi docs/rilascio.md, «Email».',
    )
  }
  return new LogMailer(log)
}

/**
 * For the emails the user is waiting for: if the message does not leave, the request fails
 * with 503 and code email_not_sent, so that they can try again. The cause goes to the log.
 */
export async function sendOrFail(
  mailer: Mailer,
  log: FastifyBaseLogger,
  message: MailMessage,
): Promise<void> {
  try {
    await mailer.send(message)
  } catch (error) {
    log.error({ err: error, subject: message.subject }, 'email non inviata')
    throw new ApiError(503, messages.emailNotSent, 'email_not_sent')
  }
}
