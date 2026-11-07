import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../config.js'
import { checkCsrf, requireSession } from './request-context.js'
import { MAX_DOCUMENT_BYTES, contentDisposition } from '../routes/site-documents.js'

/** The PDF of an invoice or a compliance document, or a scan or photo of it. */
export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number]

/** File metadata as the contract shows it, built by the database (see ATTACHMENT_JSON). */
export interface AttachmentInfo {
  file_name: string
  content_type: AttachmentType
  size: number
  uploaded_at: string
}

/** json_build_object of an attachment row aliased f, matching AttachmentInfo. */
export const ATTACHMENT_JSON = `json_build_object('file_name', f.file_name,
  'content_type', f.content_type, 'size', f.size_bytes,
  'uploaded_at', to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`

/** Sends a stored file as a download that the browser never runs. */
export function sendAttachment(
  reply: FastifyReply,
  file: { file_name: string; content_type: string; data: Buffer; version: number },
) {
  return reply
    .header('Content-Type', file.content_type)
    .header('Content-Disposition', contentDisposition(file.file_name))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Cache-Control', 'private, no-cache')
    .header('ETag', `"${file.version}"`)
    .send(file.data)
}

/**
 * A scope whose routes take a raw file of one of ATTACHMENT_TYPES as body, up to 20 MB.
 * Session and CSRF are checked before the body is read.
 */
export function uploadScope(
  app: FastifyInstance,
  config: Config,
  routes: (scope: FastifyInstance) => void,
): void {
  app.register((scope, _options, done) => {
    scope.addHook('preParsing', (request, _reply, payload, done) => {
      try {
        requireSession(request)
        checkCsrf(config, request)
      } catch (error) {
        done(error as Error)
        return
      }
      done(null, payload)
    })
    scope.addContentTypeParser(
      [...ATTACHMENT_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES },
      (_request, body, done) => {
        done(null, body)
      },
    )
    routes(scope)
    done()
  })
}
