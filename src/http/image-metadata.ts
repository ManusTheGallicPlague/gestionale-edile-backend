/**
 * Photos taken with a phone carry where they were taken (GPS coordinates in Exif or XMP),
 * and often the phone model and the time. An uploaded image loses all of it before it is
 * stored: JPEG, PNG and WebP, the image types the API accepts.
 *
 * Only the metadata containers are dropped, the image data is copied byte by byte, so
 * nothing is decoded or re-encoded. What cannot be parsed is copied as it is: the type was
 * already checked from the first bytes, and a broken file stays as broken as it came.
 */

/** The image without location and other metadata; any other type comes back unchanged. */
export function stripImageMetadata(data: Buffer, contentType: string): Buffer {
  switch (contentType) {
    case 'image/jpeg':
      return stripJpeg(data)
    case 'image/png':
      return stripPng(data)
    case 'image/webp':
      return stripWebp(data)
    default:
      return data
  }
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1')
const ORIENTATION_TAG = 0x0112

/**
 * JPEG: drops every APP1 segment (Exif, with the GPS data, and XMP) and APP13 (Photoshop
 * and IPTC, which can hold the place too). The orientation is the one Exif value that
 * changes how the photo looks (phones store it rotated and say so there): when it is not
 * the default, it goes back in a new Exif segment with that tag alone.
 */
function stripJpeg(data: Buffer): Buffer {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return data
  const kept: Buffer[] = []
  let orientation: number | undefined
  let pos = 2
  while (pos + 4 <= data.length && data[pos] === 0xff) {
    const marker = data[pos + 1] ?? 0
    if (marker === 0xff) {
      pos += 1 // fill byte
      continue
    }
    // Start of scan or end of image: from here on it is image data.
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(data.subarray(pos, pos + 2))
      pos += 2
      continue
    }
    const length = data.readUInt16BE(pos + 2)
    const end = pos + 2 + length
    if (length < 2 || end > data.length) break
    if (marker === 0xe1) {
      const payload = data.subarray(pos + 4, end)
      if (orientation === undefined && payload.subarray(0, 6).equals(EXIF_HEADER)) {
        orientation = readOrientation(payload.subarray(6))
      }
    } else if (marker !== 0xed) {
      kept.push(data.subarray(pos, end))
    }
    pos = end
  }
  const rest = data.subarray(pos)
  if (orientation !== undefined && orientation >= 2 && orientation <= 8) {
    // After the JFIF header when there is one: it must stay first.
    const first = kept[0]
    const jfif = first !== undefined && first[1] === 0xe0 ? 1 : 0
    kept.splice(jfif, 0, orientationSegment(orientation))
  }
  return Buffer.concat([data.subarray(0, 2), ...kept, rest])
}

/** The Orientation tag of the first image directory of a TIFF block, if readable. */
function readOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return undefined
  const little = order === 'II'
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  if (u16(2) !== 42) return undefined
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return undefined
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return undefined
    // Type 3 is SHORT: the value sits in the first two bytes of the value field.
    if (u16(entry) === ORIENTATION_TAG && u16(entry + 2) === 3) return u16(entry + 8)
  }
  return undefined
}

/** An APP1 Exif segment with one tag, the orientation. */
function orientationSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // first directory right after the header
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(ORIENTATION_TAG, 10)
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14) // one value
  tiff.writeUInt16BE(orientation, 18)
  // Bytes 20-21 pad the value field, 22-25 say there is no next directory.
  const payload = Buffer.concat([EXIF_HEADER, tiff])
  const header = Buffer.from([0xff, 0xe1, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * PNG: drops the eXIf chunk and the text chunks that carry XMP or Exif (the keyword
 * XML:com.adobe.xmp, and the "Raw profile type" ones some editors write). The orientation
 * in eXIf goes too: viewers rarely apply it to a PNG, and phones save photos as JPEG.
 */
function stripPng(data: Buffer): Buffer {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return data
  const kept: Buffer[] = [data.subarray(0, 8)]
  let pos = 8
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos)
    const end = pos + 12 + length
    if (end > data.length) break
    const type = data.toString('latin1', pos + 4, pos + 8)
    if (!isPngMetadata(type, data.subarray(pos + 8, pos + 8 + length))) {
      kept.push(data.subarray(pos, end))
    }
    pos = end
  }
  kept.push(data.subarray(pos))
  return Buffer.concat(kept)
}

function isPngMetadata(type: string, body: Buffer): boolean {
  if (type === 'eXIf') return true
  if (type !== 'iTXt' && type !== 'tEXt' && type !== 'zTXt') return false
  const nul = body.indexOf(0)
  const keyword = body.toString('latin1', 0, nul < 0 ? Math.min(body.length, 79) : nul)
  return keyword === 'XML:com.adobe.xmp' || keyword.startsWith('Raw profile type')
}

/**
 * WebP: drops the EXIF and XMP chunks, clears their flags in the VP8X header and fixes the
 * size of the RIFF container. The orientation goes with Exif here as well.
 */
function stripWebp(data: Buffer): Buffer {
  if (
    data.length < 12 ||
    data.toString('latin1', 0, 4) !== 'RIFF' ||
    data.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return data
  }
  const kept: Buffer[] = []
  let pos = 12
  while (pos + 8 <= data.length) {
    const type = data.toString('latin1', pos, pos + 4)
    const length = data.readUInt32LE(pos + 4)
    const end = pos + 8 + length + (length % 2)
    if (end > data.length) break
    if (type === 'VP8X' && length >= 1) {
      const chunk = Buffer.from(data.subarray(pos, end))
      chunk[8] = (chunk[8] ?? 0) & ~0x0c // the EXIF (0x08) and XMP (0x04) flags
      kept.push(chunk)
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      kept.push(data.subarray(pos, end))
    }
    pos = end
  }
  kept.push(data.subarray(pos))
  const header = Buffer.from(data.subarray(0, 12))
  const body = Buffer.concat(kept)
  header.writeUInt32LE(body.length + 4, 4)
  return Buffer.concat([header, body])
}
