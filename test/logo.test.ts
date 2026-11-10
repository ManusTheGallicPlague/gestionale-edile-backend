import { deflateSync, inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partitaIvaCheckDigit } from '../src/clients/tax-ids.js'
import type { Permission } from '../src/permissions.js'
import { readImage } from '../src/pdf/image.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

function chunk(name: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(name, 4, 'latin1')
  return Buffer.concat([head, body, Buffer.alloc(4)])
}

/** A PNG with every row filter, so unfiltering is exercised. Colour type 6 = RGBA. */
function png(width: number, height: number, type = 6, depth = 8): Buffer {
  const channels = type === 6 ? 4 : type === 2 ? 3 : 1
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels)
    row[0] = y % 5
    for (let i = 1; i < row.length; i++) row[i] = (i * 7 + y * 13) & 0xff
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = type
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Just the markers a reader looks at: SOI, an APP0, a baseline frame header, EOI. */
function jpeg(width: number, height: number, components = 3): Buffer {
  const frame = Buffer.from([
    0xff,
    0xc0,
    0x00,
    8 + components * 3,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
    ...Array<number>(components * 3).fill(1),
  ])
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.from([0xff, 0xd9])])
}

async function scene(
  permissions: Permission[] = ['settings.update', 'quotes.view', 'quotes.create'],
) {
  const { company, user } = await fx.companyWithUser(permissions)
  const browser = new Browser(ctx.app)
  await browser.signIn(user.email)
  const url = `/api/companies/${company.slug}/settings/logo`
  const upload = (body: Buffer, type = 'image/png') =>
    browser.call('PUT', url, { body, headers: { 'content-type': type } })
  return { browser, company, url, upload }
}

describe('company logo', () => {
  it('is in the audit log as the field logo of the company details', async () => {
    const { browser, company, upload } = await scene(['settings.update', 'audit.view'])
    expect((await upload(png(40, 20))).statusCode).toBe(204)
    expect((await upload(jpeg(300, 100), 'image/jpeg')).statusCode).toBe(204)
    expect(
      (await browser.call('DELETE', `/api/companies/${company.slug}/settings/logo`)).statusCode,
    ).toBe(204)
    const log = await browser.call(
      'GET',
      `/api/companies/${company.slug}/audit-log?filter[entity]=company_profile`,
    )
    expect(log.statusCode).toBe(200)
    expect(
      log
        .json<{ data: { entity_id: string; action: string; fields: string[] }[] }>()
        .data.map((e) => [e.entity_id, e.action, e.fields]),
    ).toEqual([
      [company.id, 'update', ['logo']],
      [company.id, 'update', ['logo']],
      [company.id, 'update', ['logo']],
    ])
    // Another company's logo is not in this log.
    const other = await fx.company()
    await ctx.owner.query(
      "insert into public.company_logos (company_id, content_type, data) values ($1, 'image/png', '\\x01')",
      [other.id],
    )
    const all = await browser.call('GET', `/api/companies/${company.slug}/audit-log`)
    expect(
      all.json<{ data: { entity_id: string }[] }>().data.map((e) => e.entity_id),
    ).not.toContain(other.id)
  })

  it('is uploaded, read back, replaced and deleted', async () => {
    const { browser, url, upload } = await scene()
    expect((await browser.call('GET', url)).statusCode).toBe(404)
    const image = png(40, 20)
    const saved = await upload(image)
    expect(saved.statusCode).toBe(204)
    expect(saved.headers.etag).toBe('"1"')
    const read = await browser.call('GET', url)
    expect(read.headers['content-type']).toBe('image/png')
    expect(read.rawPayload.equals(image)).toBe(true)
    const replaced = await upload(jpeg(300, 100), 'image/jpeg')
    expect(replaced.headers.etag).toBe('"2"')
    expect((await browser.call('GET', url)).headers['content-type']).toBe('image/jpeg')
    // Larger than the 64 KB of JSON bodies, within the 512 KB of logos.
    expect((await upload(Buffer.concat([png(4, 4), Buffer.alloc(400_000)]))).statusCode).toBe(204)
    expect((await browser.call('DELETE', url)).statusCode).toBe(204)
    expect((await browser.call('GET', url)).statusCode).toBe(404)
    expect((await browser.call('DELETE', url)).statusCode).toBe(204)
  })

  it.each([
    ['a PNG sent as JPEG', png(4, 4), 'image/jpeg', 422],
    ['text', Buffer.from('ciao'), 'image/png', 422],
    ['a 16-bit PNG', png(4, 4, 6, 16), 'image/png', 422],
    ['a palette PNG', png(4, 4, 3), 'image/png', 422],
    ['a huge PNG', png(2001, 1), 'image/png', 422],
    ['a CMYK JPEG', jpeg(10, 10, 4), 'image/jpeg', 422],
    ['a file over 512 KB', Buffer.concat([png(1, 1), Buffer.alloc(600_000)]), 'image/png', 413],
    ['another content type', Buffer.from('x'), 'application/octet-stream', 415],
  ])('refuses %s', async (_label, body, type, status) => {
    const { upload } = await scene()
    expect((await upload(body, type)).statusCode).toBe(status)
  })

  it('needs settings.update to change it; any member sees it; other companies do not', async () => {
    const owner = await scene()
    await owner.upload(png(4, 4))
    // A member with no permissions at all still sees the logo of the company.
    const member = await fx.user()
    const role = await fx.role(owner.company.id, 'Nessuno', [])
    await fx.member(member.id, owner.company.id, role)
    const browser = new Browser(ctx.app)
    await browser.signIn(member.email)
    expect((await browser.call('GET', owner.url)).statusCode).toBe(200)
    expect(
      (
        await browser.call('PUT', owner.url, {
          body: png(2, 2),
          headers: { 'content-type': 'image/png' },
        })
      ).statusCode,
    ).toBe(403)
    expect((await browser.call('DELETE', owner.url)).statusCode).toBe(403)
    const other = await scene()
    expect((await other.browser.call('GET', owner.url)).statusCode).toBe(404)
    expect((await other.browser.call('DELETE', owner.url)).statusCode).toBe(404)
    expect(
      (
        await other.browser.call('PUT', owner.url, {
          body: png(2, 2),
          headers: { 'content-type': 'image/png' },
        })
      ).statusCode,
    ).toBe(404)
    expect((await owner.browser.call('GET', owner.url)).rawPayload.equals(png(4, 4))).toBe(true)
  })

  it('is printed on the quote PDF, with its transparency', async () => {
    const { browser, company, upload } = await scene()
    await upload(png(40, 20))
    const vat = '0123456789'
    const client = await ctx.owner.query<{ id: string }>(
      "insert into public.clients (company_id, kind, name, vat_number) values ($1, 'company', 'Cliente', $2) returning id",
      [company.id, vat + partitaIvaCheckDigit(vat)],
    )
    const quotes = `/api/companies/${company.slug}/quotes`
    const quote = await browser.call('POST', quotes, {
      body: {
        client_id: client.rows[0]?.id,
        subject: 'P',
        validity_days: 30,
        notes: null,
        terms: null,
      },
    })
    const pdf = await browser.call('GET', `${quotes}/${quote.json<{ id: string }>().id}/pdf`)
    const text = pdf.rawPayload.toString('latin1')
    expect(text).toContain('/Subtype /Image /Width 40 /Height 20 /ColorSpace /DeviceRGB')
    expect(text).toContain('/Subtype /Image /Width 40 /Height 20 /ColorSpace /DeviceGray')
    expect(text).toMatch(/\/SMask \d+ 0 R/)
    expect(text).toContain('/Im0 Do')
  })
})

describe('PNG reading', () => {
  it('undoes the row filters exactly', () => {
    // Two pixels per row, RGBA; rows filtered with Sub then Up then Paeth.
    const raw = Buffer.from([
      1,
      10,
      20,
      30,
      255,
      5,
      5,
      5,
      0, // Sub: second pixel = first + 5
      2,
      1,
      1,
      1,
      0,
      1,
      1,
      1,
      0, // Up: each byte + the row above
      4,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // Paeth with zeros: copies the predictor
    ])
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(3, 4)
    header[8] = 8
    header[9] = 6
    const file = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    const image = readImage(file)
    expect([...inflateSync(image.data)]).toEqual([
      10, 20, 30, 15, 25, 35, 11, 21, 31, 16, 26, 36, 11, 21, 31, 16, 26, 36,
    ])
    expect([...inflateSync(image.alpha ?? Buffer.alloc(0))]).toEqual([255, 255, 255, 255, 255, 255])
  })
})
