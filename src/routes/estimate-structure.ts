import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import pg from 'pg'
import { isForeignKeyViolation, withIdentity } from '../db.js'
import { enterCompany } from '../company.js'
import { UUID } from '../deadlines/input.js'
import { amountToCents, centsToAmount } from '../money.js'
import {
  ApiError,
  ValidationFailed,
  forbidden,
  messages,
  notFound,
  type FieldErrors,
} from '../http/errors.js'
import { checkCsrf, requireSession } from '../http/request-context.js'

/** Chapters can be nested up to this many levels (the first level is 1). */
export const MAX_CHAPTER_DEPTH = 4

type Params = {
  company: string
  estimate: string
  chapter?: string
  item?: string
  measurement?: string
}

interface ChapterRow {
  id: string
  parent_id: string | null
  code: string | null
  title: string
  position: number
  version: number
  amount_cents: string
}

interface ItemRow {
  id: string
  chapter_id: string
  code: string | null
  description: string
  unit: string
  unit_price_cents: string
  quantity: string
  amount_cents: string
  position: number
  version: number
}

const CHAPTER_COLUMNS = 'id, parent_id, code, title, position, version'
const ITEM_SELECT = `select i.id, i.chapter_id, i.code, i.description, i.unit,
    i.unit_price_cents::text as unit_price_cents, round(t.quantity, 3)::text as quantity,
    t.amount_cents::text as amount_cents, i.position, i.version
  from public.estimate_items i
  join public.estimate_item_totals t on t.item_id = i.id`

/** A chapter with its amount: its items and those of all its sub-chapters. */
async function readChapter(client: PoolClient, id: string) {
  const { rows } = await client.query<ChapterRow>(
    `with recursive sub as (
       select id from public.estimate_chapters where id = $1
       union all
       select c.id from public.estimate_chapters c join sub on c.parent_id = sub.id
     )
     select ${CHAPTER_COLUMNS},
       (select coalesce(sum(t.amount_cents), 0)::text from public.estimate_item_totals t
        where t.chapter_id in (select id from sub)) as amount_cents
     from public.estimate_chapters where id = $1`,
    [id],
  )
  return rows[0]
}

async function readItem(client: PoolClient, id: string) {
  const { rows } = await client.query<ItemRow>(`${ITEM_SELECT} where i.id = $1`, [id])
  return rows[0]
}

interface MeasurementRow {
  id: string
  item_id: string
  description: string | null
  equal_parts: string | null
  length: string | null
  width: string | null
  height: string | null
  quantity: string
  position: number
  version: number
}

const FACTORS = ['equal_parts', 'length', 'width', 'height'] as const
const FACTOR = /^-?\d{1,9}(?:\.\d{1,3})?$/

const MEASUREMENT_COLUMNS = `id, item_id, description, equal_parts::text as equal_parts,
    length::text as length, width::text as width, height::text as height,
    quantity::text as quantity, position, version`
const MEASUREMENT_SELECT = `select ${MEASUREMENT_COLUMNS} from public.estimate_measurements`

const etag = (version: number) => `"${version}"`

const chapterToContract = (row: ChapterRow) => ({
  id: row.id,
  parent_id: row.parent_id,
  code: row.code,
  title: row.title,
  amount: centsToAmount(row.amount_cents),
  position: row.position,
  version: etag(row.version),
})

const itemToContract = (row: ItemRow) => ({
  id: row.id,
  chapter_id: row.chapter_id,
  code: row.code,
  description: row.description,
  unit: row.unit,
  unit_price: centsToAmount(row.unit_price_cents),
  quantity: row.quantity,
  amount: centsToAmount(row.amount_cents),
  position: row.position,
  version: etag(row.version),
})

const measurementToContract = (row: MeasurementRow) => ({
  id: row.id,
  item_id: row.item_id,
  description: row.description,
  equal_parts: row.equal_parts,
  length: row.length,
  width: row.width,
  height: row.height,
  quantity: row.quantity,
  position: row.position,
  version: etag(row.version),
})

function expectedVersion(header: string | string[] | undefined): number {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiError(428, messages.structureMissingIfMatch, 'precondition_required')
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim())
  return match ? Number(match[1]) : -1
}

/** Reads the body as an object with a helper for optional/required trimmed texts. */
function reader(body: unknown) {
  const errors: FieldErrors = {}
  const add = (field: string, message: string) => {
    ;(errors[field] ??= []).push(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const text = (field: string, max: number, required?: string): string | null => {
    if (!(field in raw)) {
      add(field, 'Campo mancante.')
      return null
    }
    const value = raw[field]
    if (value === null) {
      if (required) add(field, required)
      return null
    }
    if (typeof value !== 'string') {
      add(field, 'Deve essere un testo.')
      return null
    }
    const trimmed = value.trim()
    if (trimmed.length > max) add(field, `Al massimo ${max} caratteri.`)
    if (trimmed === '' && required) add(field, required)
    return trimmed === '' ? null : trimmed
  }
  const id = (field: string, message: string): string | null => {
    const value = text(field, 36)
    if (value !== null && !UUID.test(value) && !errors[field]) add(field, message)
    return value
  }
  const done = () => {
    if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  }
  return { raw, text, id, add, errors, done }
}

function parseChapter(body: unknown, withParent: boolean) {
  const r = reader(body)
  const code = r.text('code', 50)
  const title = r.text('title', 200, 'Il titolo è obbligatorio.')
  const parent_id = withParent ? r.id('parent_id', 'Capitolo non trovato.') : null
  r.done()
  return { code, title: title ?? '', parent_id }
}

function parseItem(body: unknown, withChapter: boolean) {
  const r = reader(body)
  const chapter_id = withChapter ? r.id('chapter_id', 'Capitolo non trovato.') : null
  if (withChapter && chapter_id === null && !r.errors.chapter_id) {
    r.add('chapter_id', 'Il capitolo è obbligatorio.')
  }
  const code = r.text('code', 50)
  const description = r.text('description', 5000, 'La descrizione è obbligatoria.')
  const unit = r.text('unit', 20, "L'unità di misura è obbligatoria.")
  let unitPriceCents: string | null = null
  if (!('unit_price' in r.raw)) r.add('unit_price', 'Campo mancante.')
  else {
    const value = r.raw.unit_price
    unitPriceCents = typeof value === 'string' ? amountToCents(value.trim()) : null
    if (unitPriceCents === null) {
      r.add('unit_price', 'Un importo come 1234.50, con il punto e al massimo due decimali.')
    }
  }
  r.done()
  return {
    chapter_id,
    code,
    description: description ?? '',
    unit: unit ?? '',
    unitPriceCents: unitPriceCents ?? '0',
  }
}

function parseMeasurement(body: unknown, withItem: boolean) {
  const r = reader(body)
  const item_id = withItem ? r.id('item_id', 'Voce non trovata.') : null
  if (withItem && item_id === null && !r.errors.item_id) r.add('item_id', 'La voce è obbligatoria.')
  const description = r.text('description', 500)
  const factors: (string | null)[] = FACTORS.map((field) => {
    if (!(field in r.raw)) {
      r.add(field, 'Campo mancante.')
      return null
    }
    const value = r.raw[field]
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null
    if (typeof value !== 'string' || !FACTOR.test(value.trim())) {
      r.add(field, 'Un numero come 12.5 o -3, con il punto e al massimo tre decimali.')
      return null
    }
    return value.trim()
  })
  if (Object.keys(r.errors).length === 0 && factors.every((f) => f === null)) {
    r.add('quantity', 'Indica almeno un valore tra parti uguali, lunghezza, larghezza e altezza.')
  }
  r.done()
  return { item_id, description, factors }
}

function quantityTooLarge(error: unknown): never {
  if (error instanceof pg.DatabaseError && error.code === '22003') {
    throw new ValidationFailed({ quantity: ['La quantità è troppo grande.'] })
  }
  throw error
}

/** Opens the company, checks the permission and that the estimate exists (else 404). */
async function enterEstimate(
  client: PoolClient,
  request: FastifyRequest<{ Params: Params }>,
  permission: 'estimates.view' | 'estimates.update',
) {
  const permissions = await enterCompany(client, request.params.company)
  if (!permissions.has(permission)) {
    if (permission === 'estimates.view') throw notFound()
    throw forbidden()
  }
  const id = request.params.estimate
  if (!UUID.test(id)) throw notFound()
  const { rowCount } = await client.query('select 1 from public.estimates where id = $1', [id])
  if (!rowCount) throw notFound()
  return id
}

/** The estimate's last change, for the "last modified" order of the list. */
/** Every change in the tree: the estimate's last change and a new tree version. */
const touch = (client: PoolClient, estimateId: string) =>
  client.query(
    `update public.estimates
     set updated_at = now(), structure_version = structure_version + 1 where id = $1`,
    [estimateId],
  )

async function readStructure(client: PoolClient, estimateId: string) {
  const version = await client.query<{ structure_version: number }>(
    'select structure_version from public.estimates where id = $1',
    [estimateId],
  )
  const chapters = await client.query<Omit<ChapterRow, 'amount_cents'>>(
    `select ${CHAPTER_COLUMNS} from public.estimate_chapters
     where estimate_id = $1 order by parent_id nulls first, position, id`,
    [estimateId],
  )
  const items = await client.query<ItemRow>(
    `${ITEM_SELECT} where i.estimate_id = $1 order by i.chapter_id, i.position, i.id`,
    [estimateId],
  )
  const measurements = await client.query<MeasurementRow>(
    `${MEASUREMENT_SELECT} where estimate_id = $1 order by item_id, position, id`,
    [estimateId],
  )
  const amounts = chapterAmounts(chapters.rows, items.rows)
  const total = items.rows.reduce((sum, i) => sum + BigInt(i.amount_cents), 0n)
  return {
    version: version.rows[0]?.structure_version ?? 1,
    body: {
      total: centsToAmount(total.toString()),
      chapters: chapters.rows.map((c) =>
        chapterToContract({ ...c, amount_cents: (amounts.get(c.id) ?? 0n).toString() }),
      ),
      items: items.rows.map(itemToContract),
      measurements: measurements.rows.map(measurementToContract),
    },
  }
}

interface Arrangement {
  chapters: { id: string; parent_id: string | null }[]
  items: { id: string; chapter_id: string }[]
}

function parseArrangement(body: unknown): Arrangement {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed({ _: ['Il corpo della richiesta deve essere un oggetto JSON.'] })
  }
  const raw = body as Record<string, unknown>
  const errors: FieldErrors = {}
  const list = <T>(
    field: 'chapters' | 'items',
    max: number,
    parentField: string,
    nullable: boolean,
  ): T[] => {
    const value = raw[field]
    if (!Array.isArray(value)) {
      errors[field] = ['Deve essere un elenco.']
      return []
    }
    if (value.length > max) {
      errors[field] = [`Al massimo ${max} elementi.`]
      return []
    }
    const ok = value.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      const parent = e[parentField]
      return (
        typeof e.id === 'string' &&
        UUID.test(e.id) &&
        ((nullable && parent === null) || (typeof parent === 'string' && UUID.test(parent)))
      )
    })
    if (!ok) errors[field] = [`Ogni elemento vuole id e ${parentField} validi.`]
    return value as T[]
  }
  const chapters = list<Arrangement['chapters'][number]>('chapters', 2000, 'parent_id', true)
  const items = list<Arrangement['items'][number]>('items', 10000, 'chapter_id', false)
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)
  return {
    chapters: chapters.map((c) => ({ id: c.id, parent_id: c.parent_id })),
    items: items.map((i) => ({ id: i.id, chapter_id: i.chapter_id })),
  }
}

const sameSet = (given: string[], existing: string[]) => {
  const set = new Set(given)
  return (
    set.size === given.length &&
    given.length === existing.length &&
    existing.every((id) => set.has(id))
  )
}

/** Checks the new layout against the estimate's tree and writes parents and positions. */
async function arrange(client: PoolClient, estimateId: string, layout: Arrangement) {
  const chapters = await client.query<{ id: string }>(
    'select id from public.estimate_chapters where estimate_id = $1',
    [estimateId],
  )
  const items = await client.query<{ id: string }>(
    'select id from public.estimate_items where estimate_id = $1',
    [estimateId],
  )
  const errors: FieldErrors = {}
  const chapterIds = layout.chapters.map((c) => c.id)
  if (
    !sameSet(
      chapterIds,
      chapters.rows.map((r) => r.id),
    )
  ) {
    errors.chapters = [
      'Servono tutti i capitoli del computo, ognuno una volta sola: ricarica la pagina.',
    ]
  }
  if (
    !sameSet(
      layout.items.map((i) => i.id),
      items.rows.map((r) => r.id),
    )
  ) {
    errors.items = ['Servono tutte le voci del computo, ognuna una volta sola: ricarica la pagina.']
  }
  if (Object.keys(errors).length > 0) throw new ValidationFailed(errors)

  const parent = new Map(layout.chapters.map((c) => [c.id, c.parent_id]))
  for (const chapter of layout.chapters) {
    if (chapter.parent_id !== null && !parent.has(chapter.parent_id)) {
      throw new ValidationFailed({ chapters: ['Un capitolo ha un genitore che non esiste.'] })
    }
    // Walk up: a cycle or a fifth level shows up within MAX_CHAPTER_DEPTH steps.
    let depth = 1
    for (let p = chapter.parent_id; p !== null; p = parent.get(p) ?? null) {
      depth += 1
      if (p === chapter.id || depth > MAX_CHAPTER_DEPTH) {
        throw new ValidationFailed({
          chapters: [
            p === chapter.id
              ? 'Un capitolo non può stare dentro sé stesso.'
              : `I capitoli si annidano al massimo su ${MAX_CHAPTER_DEPTH} livelli.`,
          ],
        })
      }
    }
  }
  if (layout.items.some((i) => !parent.has(i.chapter_id))) {
    throw new ValidationFailed({ items: ['Una voce ha un capitolo che non esiste.'] })
  }

  const positions = <T>(rows: T[], group: (row: T) => string | null) => {
    const next = new Map<string | null, number>()
    return rows.map((row) => {
      const position = next.get(group(row)) ?? 0
      next.set(group(row), position + 1)
      return position
    })
  }
  await client.query(
    `update public.estimate_chapters c set parent_id = v.parent_id, position = v.position
     from unnest($2::uuid[], $3::uuid[], $4::int[]) as v (id, parent_id, position)
     where c.id = v.id and c.estimate_id = $1
       and (c.parent_id is distinct from v.parent_id or c.position <> v.position)`,
    [
      estimateId,
      layout.chapters.map((c) => c.id),
      layout.chapters.map((c) => c.parent_id),
      positions(layout.chapters, (c) => c.parent_id),
    ],
  )
  await client.query(
    `update public.estimate_items i set chapter_id = v.chapter_id, position = v.position
     from unnest($2::uuid[], $3::uuid[], $4::int[]) as v (id, chapter_id, position)
     where i.id = v.id and i.estimate_id = $1
       and (i.chapter_id <> v.chapter_id or i.position <> v.position)`,
    [
      estimateId,
      layout.items.map((i) => i.id),
      layout.items.map((i) => i.chapter_id),
      positions(layout.items, (i) => i.chapter_id),
    ],
  )
}

async function chapterDepth(client: PoolClient, estimateId: string, chapterId: string) {
  const { rows } = await client.query<{ depth: number }>(
    `with recursive up as (
       select id, parent_id, 1 as depth from public.estimate_chapters
       where id = $1 and estimate_id = $2
       union all
       select c.id, c.parent_id, up.depth + 1 from public.estimate_chapters c
       join up on c.id = up.parent_id
     ) select max(depth)::int as depth from up`,
    [chapterId, estimateId],
  )
  return rows[0]?.depth ?? null
}

async function missingOrStale(
  client: PoolClient,
  table: 'estimate_chapters' | 'estimate_items' | 'estimate_measurements',
  estimateId: string,
  id: string,
): Promise<never> {
  const { rowCount } = await client.query(
    `select 1 from public.${table} where id = $1 and estimate_id = $2`,
    [id, estimateId],
  )
  if (!rowCount) throw notFound()
  const message = {
    estimate_chapters: messages.chapterStale,
    estimate_items: messages.itemStale,
    estimate_measurements: messages.measurementStale,
  }[table]
  throw new ApiError(412, message, 'stale_record')
}

const sendChapter = (reply: FastifyReply, row: ChapterRow, status = 200) =>
  reply.code(status).header('ETag', etag(row.version)).send(chapterToContract(row))
const sendItem = (reply: FastifyReply, row: ItemRow, status = 200) =>
  reply.code(status).header('ETag', etag(row.version)).send(itemToContract(row))

/** Each chapter's amount in cents (integers, never floats), sub-chapters included. */
function chapterAmounts(
  chapters: { id: string; parent_id: string | null }[],
  items: { chapter_id: string; amount_cents: string }[],
): Map<string, bigint> {
  const parent = new Map(chapters.map((c) => [c.id, c.parent_id]))
  const amounts = new Map<string, bigint>(chapters.map((c) => [c.id, 0n]))
  for (const item of items) {
    const cents = BigInt(item.amount_cents)
    for (let id: string | null | undefined = item.chapter_id; id; id = parent.get(id)) {
      amounts.set(id, (amounts.get(id) ?? 0n) + cents)
    }
  }
  return amounts
}

export function estimateStructureRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const base = '/api/companies/:company/estimates/:estimate'

  app.get<{ Params: Params }>(`${base}/structure`, async (request, reply) => {
    const session = requireSession(request)
    const { version, body } = await withIdentity(
      db.app,
      { userId: session.user.id },
      async (client) => {
        const estimateId = await enterEstimate(client, request, 'estimates.view')
        return readStructure(client, estimateId)
      },
    )
    return reply.header('ETag', etag(version)).send(body)
  })

  app.put<{ Params: Params }>(`${base}/structure`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const { version, body } = await withIdentity(
      db.app,
      { userId: session.user.id },
      async (client) => {
        const estimateId = await enterEstimate(client, request, 'estimates.update')
        const expected = expectedVersion(request.headers['if-match'])
        const arrangement = parseArrangement(request.body)
        const { rows } = await client.query<{ structure_version: number }>(
          'select structure_version from public.estimates where id = $1 for update',
          [estimateId],
        )
        if (rows[0]?.structure_version !== expected) {
          throw new ApiError(412, messages.structureStale, 'stale_record')
        }
        await arrange(client, estimateId, arrangement)
        await touch(client, estimateId)
        return readStructure(client, estimateId)
      },
    )
    return reply.header('ETag', etag(version)).send(body)
  })

  app.post<{ Params: Params }>(`${base}/chapters`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const input = parseChapter(request.body, true)
      if (input.parent_id) {
        const depth = await chapterDepth(client, estimateId, input.parent_id)
        if (depth === null) throw new ValidationFailed({ parent_id: ['Capitolo non trovato.'] })
        if (depth >= MAX_CHAPTER_DEPTH) {
          throw new ValidationFailed({
            parent_id: [`I capitoli si annidano al massimo su ${MAX_CHAPTER_DEPTH} livelli.`],
          })
        }
      }
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.estimate_chapters
             (company_id, estimate_id, parent_id, code, title, position)
           values (app.current_company_id(), $1, $2, $3, $4,
             (select coalesce(max(position) + 1, 0) from public.estimate_chapters
              where estimate_id = $1 and parent_id is not distinct from $2))
           returning id`,
          [estimateId, input.parent_id, input.code, input.title],
        )
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ValidationFailed({ parent_id: ['Capitolo non trovato.'] })
          }
          throw error
        })
      await touch(client, estimateId)
      return readChapter(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return sendChapter(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/chapters/:chapter`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.chapter ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseChapter(request.body, false)
      const { rows } = await client.query<{ id: string }>(
        `update public.estimate_chapters
         set code = $1, title = $2, version = version + 1, updated_at = now()
         where id = $3 and estimate_id = $4 and version = $5
         returning id`,
        [input.code, input.title, id, estimateId, version],
      )
      if (!rows[0]) return missingOrStale(client, 'estimate_chapters', estimateId, id)
      await touch(client, estimateId)
      return readChapter(client, id)
    })
    if (!row) throw notFound()
    return sendChapter(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/chapters/:chapter`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.chapter ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.estimate_chapters where id = $1 and estimate_id = $2 and version = $3',
        [id, estimateId, version],
      )
      if (!rowCount) await missingOrStale(client, 'estimate_chapters', estimateId, id)
      await touch(client, estimateId)
    })
    return reply.code(204).send()
  })

  app.post<{ Params: Params }>(`${base}/items`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const input = parseItem(request.body, true)
      const { rows } = await client
        .query<{ id: string }>(
          `insert into public.estimate_items
             (company_id, estimate_id, chapter_id, code, description, unit, unit_price_cents,
              position)
           values (app.current_company_id(), $1, $2, $3, $4, $5, $6,
             (select coalesce(max(position) + 1, 0) from public.estimate_items
              where estimate_id = $1 and chapter_id = $2))
           returning id`,
          [
            estimateId,
            input.chapter_id,
            input.code,
            input.description,
            input.unit,
            input.unitPriceCents,
          ],
        )
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ValidationFailed({ chapter_id: ['Capitolo non trovato.'] })
          }
          throw error
        })
      await touch(client, estimateId)
      return readItem(client, rows[0]?.id ?? '')
    })
    if (!row) throw new Error('insert returned no row')
    return sendItem(reply, row, 201)
  })

  app.put<{ Params: Params }>(`${base}/items/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.item ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseItem(request.body, false)
      const { rows } = await client.query<{ id: string }>(
        `update public.estimate_items
         set code = $1, description = $2, unit = $3, unit_price_cents = $4,
             version = version + 1, updated_at = now()
         where id = $5 and estimate_id = $6 and version = $7
         returning id`,
        [input.code, input.description, input.unit, input.unitPriceCents, id, estimateId, version],
      )
      if (!rows[0]) return missingOrStale(client, 'estimate_items', estimateId, id)
      await touch(client, estimateId)
      return readItem(client, id)
    })
    if (!row) throw notFound()
    return sendItem(reply, row)
  })

  app.delete<{ Params: Params }>(`${base}/items/:item`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.item ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        'delete from public.estimate_items where id = $1 and estimate_id = $2 and version = $3',
        [id, estimateId, version],
      )
      if (!rowCount) await missingOrStale(client, 'estimate_items', estimateId, id)
      await touch(client, estimateId)
    })
    return reply.code(204).send()
  })

  app.post<{ Params: Params }>(`${base}/measurements`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const input = parseMeasurement(request.body, true)
      const { rows } = await client
        .query<MeasurementRow>(
          `insert into public.estimate_measurements
             (company_id, estimate_id, item_id, description, ${FACTORS.join(', ')}, position)
           values (app.current_company_id(), $1, $2, $3, $4, $5, $6, $7,
             (select coalesce(max(position) + 1, 0) from public.estimate_measurements
              where estimate_id = $1 and item_id = $2))
           returning ${MEASUREMENT_COLUMNS}`,
          [estimateId, input.item_id, input.description, ...input.factors],
        )
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ValidationFailed({ item_id: ['Voce non trovata.'] })
          }
          return quantityTooLarge(error)
        })
      await touch(client, estimateId)
      return rows[0]
    })
    if (!row) throw new Error('insert returned no row')
    return reply.code(201).header('ETag', etag(row.version)).send(measurementToContract(row))
  })

  app.put<{ Params: Params }>(`${base}/measurements/:measurement`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    const row = await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.measurement ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const input = parseMeasurement(request.body, false)
      const { rows } = await client
        .query<MeasurementRow>(
          `update public.estimate_measurements
           set description = $1, equal_parts = $2, length = $3, width = $4, height = $5,
               version = version + 1, updated_at = now()
           where id = $6 and estimate_id = $7 and version = $8
           returning ${MEASUREMENT_COLUMNS}`,
          [input.description, ...input.factors, id, estimateId, version],
        )
        .catch(quantityTooLarge)
      if (!rows[0]) return missingOrStale(client, 'estimate_measurements', estimateId, id)
      await touch(client, estimateId)
      return rows[0]
    })
    return reply.header('ETag', etag(row.version)).send(measurementToContract(row))
  })

  app.delete<{ Params: Params }>(`${base}/measurements/:measurement`, async (request, reply) => {
    const session = requireSession(request)
    checkCsrf(config, request)
    await withIdentity(db.app, { userId: session.user.id }, async (client) => {
      const estimateId = await enterEstimate(client, request, 'estimates.update')
      const id = request.params.measurement ?? ''
      if (!UUID.test(id)) throw notFound()
      const version = expectedVersion(request.headers['if-match'])
      const { rowCount } = await client.query(
        `delete from public.estimate_measurements
         where id = $1 and estimate_id = $2 and version = $3`,
        [id, estimateId, version],
      )
      if (!rowCount) await missingOrStale(client, 'estimate_measurements', estimateId, id)
      await touch(client, estimateId)
    })
    return reply.code(204).send()
  })
}
