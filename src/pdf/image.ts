import { deflateSync, inflateSync } from 'node:zlib'

/**
 * Images for the PDF writer: JPEG as it is (DCTDecode) and PNG through Flate. Only what a
 * logo needs: 8-bit, not interlaced, grey or colour, with or without transparency. Anything
 * else is refused with a reason the user can act on.
 */
export interface PdfImage {
  width: number
  height: number
  colorSpace: 'DeviceRGB' | 'DeviceGray'
  filter: 'DCTDecode' | 'FlateDecode'
  decodeParms?: string
  data: Buffer
  /** Transparency, as a grey Flate image of the same size. */
  alpha?: Buffer
}

export class UnsupportedImage extends Error {}

export const MAX_SIDE = 2000

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function imageType(data: Buffer): 'image/png' | 'image/jpeg' | null {
  if (data.length > 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}

export function readImage(data: Buffer): PdfImage {
  const type = imageType(data)
  if (type === 'image/png') return readPng(data)
  if (type === 'image/jpeg') return readJpeg(data)
  throw new UnsupportedImage('Il logo deve essere un file PNG o JPEG.')
}

function checkSize(width: number, height: number) {
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new UnsupportedImage(`Il logo può essere al massimo di ${MAX_SIDE}×${MAX_SIDE} pixel.`)
  }
}

function readJpeg(data: Buffer): PdfImage {
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) break
    const marker = data[offset + 1] ?? 0
    if (marker === 0xff) {
      offset++
      continue
    }
    const length = data.readUInt16BE(offset + 2)
    // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = data.readUInt16BE(offset + 5)
      const width = data.readUInt16BE(offset + 7)
      const components = data[offset + 9]
      checkSize(width, height)
      if (data[offset + 4] !== 8 || (components !== 1 && components !== 3)) {
        throw new UnsupportedImage('Il JPEG deve essere a colori (RGB) o in scala di grigi.')
      }
      return {
        width,
        height,
        colorSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB',
        filter: 'DCTDecode',
        data,
      }
    }
    offset += 2 + length
  }
  throw new UnsupportedImage('Il file JPEG non è leggibile.')
}

function readPng(data: Buffer): PdfImage {
  let offset = 8
  let header: { width: number; height: number; depth: number; type: number; interlace: number }
  header = { width: 0, height: 0, depth: 0, type: -1, interlace: 0 }
  const idat: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const name = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (name === 'IHDR' && body.length >= 13) {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8] ?? 0,
        type: body[9] ?? -1,
        interlace: body[12] ?? 0,
      }
    } else if (name === 'IDAT') idat.push(body)
    else if (name === 'IEND') break
    offset += 12 + length
  }
  const { width, height, depth, type, interlace } = header
  checkSize(width, height)
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(type) || idat.length === 0) {
    throw new UnsupportedImage(
      'Salva il logo come PNG a 8 bit, non interlacciato, a colori o in scala di grigi.',
    )
  }
  const colors = type === 0 || type === 4 ? 1 : 3
  const colorSpace = colors === 1 ? 'DeviceGray' : 'DeviceRGB'
  const compressed = Buffer.concat(idat)
  if (type === 0 || type === 2) {
    // PDF understands PNG row filters itself (predictor 15).
    return {
      width,
      height,
      colorSpace,
      filter: 'FlateDecode',
      decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`,
      data: compressed,
    }
  }
  // With an alpha channel: unfilter, then split colour and alpha into two images.
  const channels = colors + 1
  let raw: Buffer
  try {
    raw = inflateSync(compressed, { maxOutputLength: (width * channels + 1) * height })
  } catch {
    throw new UnsupportedImage('Il file PNG non è leggibile.')
  }
  const pixels = unfilter(raw, width, height, channels)
  const color = Buffer.alloc(width * height * colors)
  const alpha = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < colors; c++) color[i * colors + c] = pixels[i * channels + c] ?? 0
    alpha[i] = pixels[i * channels + colors] ?? 255
  }
  return {
    width,
    height,
    colorSpace,
    filter: 'FlateDecode',
    data: deflateSync(color),
    alpha: deflateSync(alpha),
  }
}

/** Reverses the PNG row filters (None, Sub, Up, Average, Paeth). */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) throw new UnsupportedImage('Il file PNG è incompleto.')
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x] ?? 0
      const left = x >= bpp ? (out[row + x - bpp] ?? 0) : 0
      const up = y > 0 ? (out[row - stride + x] ?? 0) : 0
      const upLeft = y > 0 && x >= bpp ? (out[row - stride + x - bpp] ?? 0) : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new UnsupportedImage('Il file PNG non è leggibile.')
      out[row + x] = (value + predicted) & 0xff
    }
  }
  return out
}
