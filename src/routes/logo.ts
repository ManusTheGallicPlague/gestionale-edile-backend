import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { ValidationFailed, forbidden, notFound } from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'
import { UnsupportedImage, imageType, readImage, type PdfImage } from '../pdf/image.js'

export const MAX_LOGO_BYTES = 512 * 1024

interface LogoRow {
  content_type: string
  data: Buffer
  version: number
}

export async function readLogo(client: PoolClient): Promise<LogoRow | undefined> {
  const { rows } = await client.query<LogoRow>(
    'select content_type, data, version from public.company_logos where company_id = app.current_company_id()',
  )
  return rows[0]
}

/** The logo ready for a PDF, or undefined if there is none or it cannot be read. */
export async function readLogoForPdf(client: PoolClient): Promise<PdfImage | undefined> {
  const logo = await readLogo(client)
  if (!logo) return undefined
  try {
    return readImage(logo.data)
  } catch {
    return undefined
  }
}

export function logoRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const url = '/api/companies/:company/settings/logo'

  // Any member sees the logo: the interface shows it to everybody.
  app.get<{ Params: { company: string } }>(url, async (request, reply) => {
    const session = requireSession(request)
    const logo = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      await enterCompany(client, request.params.company)
      return readLogo(client)
    })
    if (!logo) throw notFound()
    return reply
      .header('Content-Type', logo.content_type)
      .header('ETag', `"${logo.version}"`)
      .send(logo.data)
  })

  app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      ['image/png', 'image/jpeg'],
      { parseAs: 'buffer', bodyLimit: MAX_LOGO_BYTES },
      (_request, body, done) => {
        done(null, body)
      },
    )

    scope.put<{ Params: { company: string } }>(url, async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      const version = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('settings.update')) throw forbidden()
        const body = request.body
        const type = Buffer.isBuffer(body) ? imageType(body) : null
        if (!Buffer.isBuffer(body) || !type || type !== request.headers['content-type']) {
          throw new ValidationFailed({ logo: ['Il logo deve essere un file PNG o JPEG.'] })
        }
        try {
          readImage(body)
        } catch (error) {
          if (error instanceof UnsupportedImage) {
            throw new ValidationFailed({ logo: [error.message] })
          }
          throw error
        }
        const { rows } = await client.query<{ version: number }>(
          `insert into public.company_logos (company_id, content_type, data)
           values (app.current_company_id(), $1, $2)
           on conflict (company_id) do update set content_type = excluded.content_type,
             data = excluded.data, version = public.company_logos.version + 1,
             updated_at = now()
           returning version`,
          [type, body],
        )
        return rows[0]?.version ?? 1
      })
      return reply.code(204).header('ETag', `"${version}"`).send()
    })

    scope.delete<{ Params: { company: string } }>(url, async (request, reply) => {
      const session = requireSession(request)
      checkCsrf(config, request)
      await withIdentity(db.app, { userId: session.user.id }, async (client) => {
        const permissions = await enterCompany(client, request.params.company)
        if (!permissions.has('settings.update')) throw forbidden()
        await client.query(
          'delete from public.company_logos where company_id = app.current_company_id()',
        )
      })
      return reply.code(204).send()
    })
    done()
  })
}
