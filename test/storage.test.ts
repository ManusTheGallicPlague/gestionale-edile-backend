/**
 * The files live in the database: each company has a total limit, so one company alone
 * cannot fill the disk. Here the limit is 1000 bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { loadConfig } from '../src/config.js'
import { readableSize } from '../src/http/storage.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

const LIMIT = 1000

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp({ storageLimitBytes: LIMIT })
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

const ALL: Permission[] = [
  'documents.view',
  'documents.create',
  'invoices.view',
  'invoices.update',
  'settings.view',
  'settings.update',
]

/** A PDF of exactly `size` bytes. */
const pdf = (size: number) =>
  Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size - 9, 0x20)])

/** A JPEG that the logo reader accepts, padded to `size` bytes with a comment segment. */
function jpeg(size: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, 0, 2, 0, 4, 1, 1, 0x11, 0])
  const end = Buffer.from([0xff, 0xd9])
  const comment = Buffer.alloc(size - 2 - frame.length - end.length, 0x20)
  comment.writeUInt16BE(0xfffe, 0)
  comment.writeUInt16BE(comment.length - 2, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, frame, end])
}

async function scene() {
  const { company, user } = await fx.companyWithUser(ALL)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
    [company.id],
  )
  const base = `/api/companies/${company.slug}`
  const upload = (body: Buffer, b: Browser = browser) =>
    b.call('POST', `${base}/sites/${rows[0]?.id ?? ''}/documents?file_name=verbale.pdf`, {
      body,
      headers: { 'content-type': 'application/pdf' },
    })
  const storage = async () =>
    (await browser.call('GET', `${base}/settings/company`)).json<{
      storage: { used_bytes: number; limit_bytes: number }
    }>().storage
  return { browser, company, base, upload, storage }
}

describe('spazio per i file di ogni azienda', () => {
  it('rifiuta con 413 il caricamento che supera il limite e mostra lo spazio usato', async () => {
    const s = await scene()
    expect(await s.storage()).toEqual({ used_bytes: 0, limit_bytes: LIMIT })
    expect((await s.upload(pdf(600))).statusCode).toBe(201)
    const full = await s.upload(pdf(600))
    expect(full.statusCode).toBe(413)
    expect(full.json()).toEqual({
      code: 'storage_full',
      message:
        "Lo spazio per i file dell'azienda è pieno (1000 byte): elimina i file che non servono più, poi riprova.",
    })
    // Up to the limit itself is fine.
    expect((await s.upload(pdf(400))).statusCode).toBe(201)
    expect(await s.storage()).toEqual({ used_bytes: 1000, limit_bytes: LIMIT })
  })

  it('conta un allegato che ne sostituisce un altro al netto di quello vecchio', async () => {
    const s = await scene()
    const { rows } = await ctx.owner.query<{ id: string }>(
      `with s as (insert into public.suppliers (company_id, name) values ($1, 'Edil Sud')
         returning id)
       insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         taxable_cents, vat_cents)
       select $1, 'received', 'F-1', '2026-10-01', s.id, 10000, 2200 from s returning id`,
      [s.company.id],
    )
    const url = `${s.base}/invoices/${rows[0]?.id ?? ''}/file?file_name=fattura.pdf`
    const put = (size: number, version: number) =>
      s.browser.call('PUT', url, {
        body: pdf(size),
        headers: { 'content-type': 'application/pdf', 'if-match': `"${version}"` },
      })
    expect((await put(700, 1)).statusCode).toBe(200)
    // 700 + 900 would not fit, but the old 700 goes away.
    expect((await put(900, 2)).statusCode).toBe(200)
    expect((await s.storage()).used_bytes).toBe(900)
    const full = await put(1100, 3)
    expect(full.statusCode).toBe(413)
    expect(full.json()).toMatchObject({ code: 'storage_full' })
    // Nothing changed: the old file and the version are still there.
    expect((await s.storage()).used_bytes).toBe(900)
    expect((await s.upload(pdf(200))).statusCode).toBe(413)
  })

  it('conta il logo, al netto di quello che sostituisce', async () => {
    const s = await scene()
    const logo = (size: number) =>
      s.browser.call('PUT', `${s.base}/settings/logo`, {
        body: jpeg(size),
        headers: { 'content-type': 'image/jpeg' },
      })
    expect((await s.upload(pdf(900))).statusCode).toBe(201)
    expect((await logo(80)).statusCode).toBe(204)
    expect((await logo(100)).statusCode).toBe(204)
    expect(await s.storage()).toEqual({ used_bytes: 1000, limit_bytes: LIMIT })
    const full = await logo(120)
    expect(full.statusCode).toBe(413)
    expect(full.json()).toMatchObject({ code: 'storage_full' })
  })

  it("non conta i file di un'altra azienda", async () => {
    const other = await scene()
    expect((await other.upload(pdf(900))).statusCode).toBe(201)
    const s = await scene()
    expect((await s.upload(pdf(900))).statusCode).toBe(201)
    expect((await s.storage()).used_bytes).toBe(900)
  })

  it('con due caricamenti insieme ne passa uno solo se lo spazio basta per uno', async () => {
    const s = await scene()
    const results = await Promise.all([s.upload(pdf(600)), s.upload(pdf(600))])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 413])
    expect((await s.storage()).used_bytes).toBe(600)
  })

  it('prende il limite da COMPANY_STORAGE_LIMIT_GB, 20 GB se manca', () => {
    const env = {
      CSRF_SECRET: 'x'.repeat(40),
      DATABASE_URL_APP: 'postgres://a@h/d',
      DATABASE_URL_AUTH: 'postgres://b@h/d',
    }
    expect(loadConfig(env).storageLimitBytes).toBe(20 * 1024 ** 3)
    expect(loadConfig({ ...env, COMPANY_STORAGE_LIMIT_GB: '0.5' }).storageLimitBytes).toBe(
      512 * 1024 ** 2,
    )
    for (const wrong of ['0', '-1', 'venti']) {
      expect(() => loadConfig({ ...env, COMPANY_STORAGE_LIMIT_GB: wrong })).toThrow(
        /COMPANY_STORAGE_LIMIT_GB/,
      )
    }
  })

  it('scrive il limite in unità leggibili', () => {
    expect(readableSize(20 * 1024 ** 3)).toBe('20 GB')
    expect(readableSize(1.5 * 1024 ** 3)).toBe('1,5 GB')
    expect(readableSize(512 * 1024 ** 2)).toBe('512 MB')
    expect(readableSize(1000)).toBe('1000 byte')
  })
})
