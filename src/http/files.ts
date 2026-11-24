import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import { ValidationFailed } from './errors.js'
import { stripImageMetadata } from './image-metadata.js'
import { reserveStorage } from './storage.js'
import { checkCsrf, requireSession } from './request-context.js'
import {
  MAX_DOCUMENT_BYTES,
  cleanFileName,
  contentDisposition,
  matchesType,
} from '../routes/site-documents.js'

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

/** An uploaded attachment, ready to store. */
export interface UploadedFile {
  file_name: string
  content_type: AttachmentType
  data: Buffer
}

/**
 * The file of an upload in an uploadScope: its name from the query string (file_name), its
 * type from Content-Type, checked against the first bytes; a photo loses its position and
 * the other metadata here. 422 when something does not fit.
 */
export function readAttachment(
  query: Record<string, unknown>,
  contentType: string | undefined,
  body: unknown,
): UploadedFile {
  const rawName = query.file_name
  const fileName = typeof rawName === 'string' ? cleanFileName(rawName) : null
  if (fileName === null || fileName.length > 200) {
    throw new ValidationFailed({
      file_name: [fileName === null ? 'Indica il nome del file.' : 'Al massimo 200 caratteri.'],
    })
  }
  const declared = (contentType ?? '').split(';')[0]?.trim()
  const type = ATTACHMENT_TYPES.find((t) => t === declared)
  if (!Buffer.isBuffer(body) || body.length === 0 || !type || !matchesType(body, type)) {
    throw new ValidationFailed({ file: ['Il file non corrisponde al suo tipo, oppure è vuoto.'] })
  }
  return { file_name: fileName, content_type: type, data: stripImageMetadata(body, type) }
}

/** The tables of the attachments, with the column that points to their record. */
const ATTACHMENT_TABLES = {
  supplier_document_files: 'document_id',
  vehicle_document_files: 'document_id',
  employee_document_files: 'document_id',
  invoice_files: 'invoice_id',
} as const

/**
 * Puts the file in place of the one the record had, if any, within the storage limit of
 * the company (413 storage_full): the old file no longer counts.
 */
export async function replaceAttachment(
  client: PoolClient,
  table: keyof typeof ATTACHMENT_TABLES,
  id: string,
  file: UploadedFile,
  storageLimit: number,
): Promise<void> {
  const key = ATTACHMENT_TABLES[table]
  await client.query(`delete from public.${table} where ${key} = $1`, [id])
  await reserveStorage(client, storageLimit, file.data.length)
  await client.query(
    `insert into public.${table}
       (${key}, company_id, file_name, content_type, size_bytes, data)
     values ($1, app.current_company_id(), $2, $3, $4, $5)`,
    [id, file.file_name, file.content_type, file.data.length, file.data],
  )
}

/** Largest CSV file an import accepts. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024

/**
 * A scope whose routes take a CSV file (text/csv) as body, as a Buffer, up to 5 MB; other
 * JSON bodies still parse, so the route answers 415 when the body is not a Buffer.
 * Session and CSRF are checked before the body is read.
 */
export function csvScope(
  app: FastifyInstance,
  config: Config,
  routes: (scope: FastifyInstance) => void,
): void {
  app.register((scope, _options, done) => {
    scope.addHook('preParsing', (request, _reply, payload, next) => {
      try {
        requireSession(request)
        checkCsrf(config, request)
      } catch (error) {
        next(error as Error)
        return
      }
      next(null, payload)
    })
    scope.addContentTypeParser(
      'text/csv',
      { parseAs: 'buffer', bodyLimit: MAX_CSV_BYTES },
      (_request, body, next) => {
        next(null, body)
      },
    )
    routes(scope)
    done()
  })
}
