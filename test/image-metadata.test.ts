/**
 * Phone photos carry the GPS position where they were taken: it goes away on upload, in
 * every place that takes images (site photos, attachments, logo), and the orientation stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Permission } from '../src/permissions.js'
import { stripImageMetadata } from '../src/http/image-metadata.js'
import { Browser, Fixtures, startApp, type TestContext } from './helpers.js'

let ctx: TestContext
let fx: Fixtures

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
})
afterAll(() => ctx.close())

/** TIFF block (little endian) with Orientation and a GPS directory: 38° 7' 12.34" N. */
function tiffWithGps(orientation: number): Buffer {
  const t = Buffer.alloc(92)
  t.write('II', 0, 'latin1')
  t.writeUInt16LE(42, 2)
  t.writeUInt32LE(8, 4)
  t.writeUInt16LE(2, 8) // IFD0: two entries
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    t.writeUInt16LE(tag, at)
    t.writeUInt16LE(type, at + 2)
    t.writeUInt32LE(count, at + 4)
    t.writeUInt32LE(value, at + 8)
  }
  entry(10, 0x0112, 3, 1, orientation) // Orientation, SHORT
  entry(22, 0x8825, 4, 1, 38) // GPSInfo: the GPS directory at 38
  t.writeUInt32LE(0, 34)
  t.writeUInt16LE(2, 38) // GPS directory: two entries
  entry(40, 0x0001, 2, 2, 0) // GPSLatitudeRef, ASCII "N"
  t.write('N', 48, 'latin1')
  entry(52, 0x0002, 5, 3, 68) // GPSLatitude, three RATIONAL at 68
  t.writeUInt32LE(0, 64)
  const rationals = [38, 1, 7, 1, 1234, 100]
  rationals.forEach((n, i) => t.writeUInt32LE(n, 68 + i * 4))
  return t
}

const GPS_VALUES = tiffWithGps(6).subarray(68)
const XMP = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="38,7.2N"/></x:xmpmeta>',
  'latin1',
)

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

/** Image data: a frame header, the start of scan, a few bytes and the end. */
const FRAME = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, 0, 2, 0, 4, 1, 1, 0x11, 0])
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9])

/** A phone photo: JFIF, Exif with orientation and GPS, XMP with GPS, then the image. */
function phoneJpeg(orientation = 6): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffWithGps(orientation)])),
    segment(0xe1, XMP),
    FRAME,
    SCAN,
  ])
}

/** The Orientation left in the file, or undefined if there is no Exif. */
function orientationOf(jpeg: Buffer): number | undefined {
  const at = jpeg.indexOf(Buffer.from('Exif\0\0', 'latin1'))
  if (at < 0) return undefined
  const tiff = jpeg.subarray(at + 6)
  expect(tiff.toString('latin1', 0, 2)).toBe('MM')
  expect(tiff.readUInt16BE(8)).toBe(1) // one tag only
  expect(tiff.readUInt16BE(10)).toBe(0x0112)
  return tiff.readUInt16BE(18)
}

function expectNoLocation(file: Buffer) {
  expect(file.includes(GPS_VALUES)).toBe(false)
  expect(file.includes(Buffer.from('GPSLatitude', 'latin1'))).toBe(false)
  expect(file.includes(Buffer.from('http://ns.adobe.com/xap', 'latin1'))).toBe(false)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  // The CRC is not checked here: four zero bytes are enough.
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('metadata of the images', () => {
  it('drops Exif and XMP from a JPEG and keeps the orientation and the image', () => {
    const photo = phoneJpeg(6)
    expect(photo.includes(GPS_VALUES)).toBe(true)
    const clean = stripImageMetadata(photo, 'image/jpeg')
    expectNoLocation(clean)
    expect(orientationOf(clean)).toBe(6)
    // JFIF first, then the new Exif, and the image data untouched.
    expect(clean.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    expect(clean.subarray(clean.length - FRAME.length - SCAN.length)).toEqual(
      Buffer.concat([FRAME, SCAN]),
    )
  })

  it('leaves no Exif at all when the photo is not rotated', () => {
    const clean = stripImageMetadata(phoneJpeg(1), 'image/jpeg')
    expectNoLocation(clean)
    expect(orientationOf(clean)).toBeUndefined()
  })

  it('reads the orientation of a big endian Exif too', () => {
    const tiff = Buffer.alloc(26)
    tiff.write('MM', 0, 'latin1')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(8, 18)
    const photo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
      FRAME,
      SCAN,
    ])
    expect(orientationOf(stripImageMetadata(photo, 'image/jpeg'))).toBe(8)
  })

  it('drops eXIf and the XMP text from a PNG', () => {
    const exif = Buffer.concat([Buffer.from('II*\0', 'latin1'), tiffWithGps(1).subarray(4)])
    const xmp = Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta exif:GPSLatitude="38"/>')
    const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))
    const idat = pngChunk('IDAT', Buffer.from([1, 2, 3]))
    const iend = pngChunk('IEND', Buffer.alloc(0))
    const title = pngChunk('tEXt', Buffer.from('Title\0Cantiere', 'latin1'))
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr,
      pngChunk('eXIf', exif),
      pngChunk('iTXt', xmp),
      title,
      idat,
      iend,
    ])
    const clean = stripImageMetadata(png, 'image/png')
    expectNoLocation(clean)
    expect(clean).toEqual(Buffer.concat([PNG_SIGNATURE, ihdr, title, idat, iend]))
  })

  it('drops EXIF and XMP from a WebP and fixes its header', () => {
    const chunk = (type: string, data: Buffer) => {
      const header = Buffer.alloc(8)
      header.write(type, 0, 'latin1')
      header.writeUInt32LE(data.length, 4)
      return Buffer.concat([header, data, Buffer.alloc(data.length % 2)])
    }
    const vp8x = (flags: number) => chunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    const image = chunk('VP8L', Buffer.from([0x2f, 1, 2, 3, 4]))
    const riff = (...chunks: Buffer[]) => {
      const body = Buffer.concat(chunks)
      const header = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')
      header.writeUInt32LE(body.length + 4, 4)
      return Buffer.concat([header, body])
    }
    const webp = riff(vp8x(0x0c | 0x10), image, chunk('EXIF', tiffWithGps(6)), chunk('XMP ', XMP))
    const clean = stripImageMetadata(webp, 'image/webp')
    expectNoLocation(clean)
    // Only the alpha flag (0x10) is left.
    expect(clean).toEqual(riff(vp8x(0x10), image))
  })

  it('copies what it cannot read and leaves other types alone', () => {
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2, 3])
    expect(stripImageMetadata(broken, 'image/jpeg')).toEqual(broken)
    const pdf = Buffer.from('%PDF-1.4 Exif GPS')
    expect(stripImageMetadata(pdf, 'application/pdf')).toBe(pdf)
  })
})

describe('uploads', () => {
  async function scene(permissions: Permission[]) {
    const { company, user } = await fx.companyWithUser(permissions)
    const browser = new Browser(ctx.app)
    await browser.signIn(user.email)
    return { browser, company, base: `/api/companies/${company.slug}` }
  }

  it('stores the site photos without the position', async () => {
    const s = await scene(['documents.view', 'documents.create'])
    const { rows } = await ctx.owner.query<{ id: string }>(
      "insert into public.sites (company_id, name) values ($1, 'Villetta') returning id",
      [s.company.id],
    )
    const url = `${s.base}/sites/${rows[0]?.id ?? ''}/documents`
    const created = await s.browser.call('POST', `${url}?file_name=foto.jpg`, {
      body: phoneJpeg(6),
      headers: { 'content-type': 'image/jpeg' },
    })
    expect(created.statusCode).toBe(201)
    const doc = created.json<{ id: string; kind: string; size: number }>()
    const file = (await s.browser.call('GET', `${url}/${doc.id}/content`)).rawPayload
    expectNoLocation(file)
    expect(orientationOf(file)).toBe(6)
    expect(doc).toMatchObject({ kind: 'photo', size: file.length })
  })

  it('stores the attachments without the position', async () => {
    const s = await scene(['invoices.view', 'invoices.create', 'invoices.update'])
    const { rows } = await ctx.owner.query<{ id: string }>(
      `with s as (insert into public.suppliers (company_id, name) values ($1, 'Edil Sud')
         returning id)
       insert into public.invoices (company_id, direction, number, invoice_date, supplier_id,
         taxable_cents, vat_cents)
       select $1, 'received', 'F-1', '2026-10-01', s.id, 10000, 2200 from s returning id`,
      [s.company.id],
    )
    const url = `${s.base}/invoices/${rows[0]?.id ?? ''}`
    const res = await s.browser.call('PUT', `${url}/file?file_name=scontrino.jpg`, {
      body: phoneJpeg(3),
      headers: { 'content-type': 'image/jpeg', 'if-match': '"1"' },
    })
    expect(res.statusCode, res.body).toBe(200)
    const file = (await s.browser.call('GET', `${url}/file`)).rawPayload
    expectNoLocation(file)
    expect(orientationOf(file)).toBe(3)
  })

  it('stores the logo without the position', async () => {
    const s = await scene(['settings.update'])
    const url = `${s.base}/settings/logo`
    const res = await s.browser.call('PUT', url, {
      body: phoneJpeg(1),
      headers: { 'content-type': 'image/jpeg' },
    })
    expect(res.statusCode, res.body).toBe(204)
    const file = (await s.browser.call('GET', url)).rawPayload
    expectNoLocation(file)
  })
})
