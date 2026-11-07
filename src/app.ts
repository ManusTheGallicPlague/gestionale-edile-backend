import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import { ResponseBeforeCommit, openTransaction, type Db } from './db.js'
import { findSession } from './auth/sessions.js'
import { ApiError, ValidationFailed, messages } from './http/errors.js'
import { COOKIES } from './http/request-context.js'
import { authRoutes } from './routes/auth.js'
import { clientRoutes } from './routes/clients.js'
import { supplierRoutes } from './routes/suppliers.js'
import { supplierDocumentRoutes } from './routes/supplier-documents.js'
import { deadlineRoutes } from './routes/deadlines.js'
import { estimateRoutes } from './routes/estimates.js'
import { siteRoutes } from './routes/sites.js'
import { employeeRoutes } from './routes/employees.js'
import { vehicleRoutes } from './routes/vehicles.js'
import { siteTeamRoutes } from './routes/site-team.js'
import { siteActivityRoutes } from './routes/site-activities.js'
import { dailyReportRoutes, dailyReportTodayRoutes } from './routes/daily-reports.js'
import { siteCostRoutes, siteCostSummaryRoutes } from './routes/site-costs.js'
import { purchaseOrderRoutes } from './routes/purchase-orders.js'
import { invoiceRoutes } from './routes/invoices.js'
import { warehouseRoutes } from './routes/warehouse.js'
import { estimateStructureRoutes } from './routes/estimate-structure.js'
import { progressStatementRoutes } from './routes/progress-statements.js'
import { quoteRoutes } from './routes/quotes.js'
import { quoteLineRoutes } from './routes/quote-lines.js'
import { logoRoutes } from './routes/logo.js'
import { siteDocumentRoutes } from './routes/site-documents.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { searchRoutes } from './routes/search.js'
import { priceListRoutes } from './routes/price-lists.js'
import { invitationRoutes } from './routes/invitations.js'
import { roleRoutes } from './routes/roles.js'
import { auditLogRoutes } from './routes/audit-log.js'
import { healthRoutes } from './routes/health.js'
import { numberingRoutes, settingsRoutes } from './routes/settings.js'
import { meRoutes } from './routes/me.js'
import { passwordResetRoutes } from './routes/password-reset.js'
import { LogMailer, type Mailer } from './mail/mailer.js'

export function buildApp(
  config: Config,
  db: Db,
  options: { logger?: boolean; mailer?: Mailer } = {},
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

  const mailer = options.mailer ?? new LogMailer(app.log)

  app.register(cookie)
  app.decorateRequest('session', null)

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[COOKIES.session]
    request.session = token ? await findSession(db.auth, token) : null
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    const transaction = openTransaction.getStore()
    if (transaction && !transaction.responseSent) {
      // The error handler's 500 passes through here again and goes out.
      transaction.responseSent = true
      throw new ResponseBeforeCommit()
    }
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

  healthRoutes(app, db)
  authRoutes(app, config, db)
  passwordResetRoutes(app, config, db, mailer)
  meRoutes(app, config, db)
  clientRoutes(app, config, db)
  supplierRoutes(app, config, db)
  supplierDocumentRoutes(app, config, db)
  deadlineRoutes(app, config, db)
  estimateRoutes(app, config, db)
  siteRoutes(app, config, db)
  employeeRoutes(app, config, db)
  vehicleRoutes(app, config, db)
  siteTeamRoutes(app, config, db)
  siteActivityRoutes(app, config, db)
  dailyReportTodayRoutes(app, db)
  dailyReportRoutes(app, config, db)
  siteCostRoutes(app, config, db)
  purchaseOrderRoutes(app, config, db)
  invoiceRoutes(app, config, db)
  warehouseRoutes(app, config, db)
  siteDocumentRoutes(app, config, db)
  dashboardRoutes(app, db)
  searchRoutes(app, db)
  priceListRoutes(app, config, db)
  siteCostSummaryRoutes(app, db)
  estimateStructureRoutes(app, config, db)
  progressStatementRoutes(app, config, db)
  quoteRoutes(app, config, db)
  quoteLineRoutes(app, config, db)
  settingsRoutes(app, config, db)
  numberingRoutes(app, config, db)
  logoRoutes(app, config, db)
  roleRoutes(app, config, db)
  invitationRoutes(app, config, db, mailer)
  auditLogRoutes(app, config, db)

  return app
}
