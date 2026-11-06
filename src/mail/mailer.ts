import type { FastifyBaseLogger } from 'fastify'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

/**
 * Sends email. The API only depends on this interface: a real provider (SMTP or an HTTP
 * service) plugs in here without touching the routes.
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

/** For tests: keeps the messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []

  send(message: MailMessage): Promise<void> {
    this.sent.push(message)
    return Promise.resolve()
  }
}
