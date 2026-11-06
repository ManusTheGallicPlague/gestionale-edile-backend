import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { findSession } from './auth/sessions.js'
import { ApiError, ValidationFailed, messages } from './http/errors.js'
import { COOKIES } from './http/request-context.js'
import { authRoutes } from './routes/auth.js'
import { clientRoutes } from './routes/clients.js'
import { supplierRoutes } from './routes/suppliers.js'
import { supplierDocumentRoutes } from './routes/supplier-documents.js'
import { deadlineRoutes } from './routes/deadlines.js'
import { estimateRoutes } from './routes/estimates.js'
import { estimateStructureRoutes } from './routes/estimate-structure.js'
import { quoteRoutes } from './routes/quotes.js'
import { quoteLineRoutes } from './routes/quote-lines.js'
import { settingsRoutes } from './routes/settings.js'
import { meRoutes } from './routes/me.js'

export function buildApp(
  config: Config,
  db: Db,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.cookie',
              'req.headers["x-xsrf-token"]',
              'res.headers["set-cookie"]',
            ],
          },
  })

  app.register(cookie)
  app.decorateRequest('session', null)

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[COOKIES.session]
    request.session = token ? await findSession(db.auth, token) : null
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationFailed) {
      return reply.code(422).send({ message: error.message, errors: error.errors })
    }
    if (error instanceof ApiError) {
      return reply
        .code(error.status)
        .headers(error.headers)
        .send(
          error.code ? { message: error.message, code: error.code } : { message: error.message },
        )
    }
    const status = (error as { statusCode?: number }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify's own refusals (malformed JSON, body too large, wrong content type)
      return reply.code(status).send({ message: messages.badRequest })
    }
    request.log.error(error)
    return reply.code(500).send({ message: messages.internal })
  })

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ message: messages.notFound })
  })

  authRoutes(app, config, db)
  meRoutes(app, db)
  clientRoutes(app, config, db)
  supplierRoutes(app, config, db)
  supplierDocumentRoutes(app, config, db)
  deadlineRoutes(app, config, db)
  estimateRoutes(app, config, db)
  estimateStructureRoutes(app, config, db)
  quoteRoutes(app, config, db)
  quoteLineRoutes(app, config, db)
  settingsRoutes(app, config, db)

  return app
}
