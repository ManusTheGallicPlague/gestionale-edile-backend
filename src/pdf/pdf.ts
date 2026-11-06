/**
 * A small PDF writer: A4 pages with text in the two standard Helvetica fonts and lines.
 * Standard fonts need no embedding; text is encoded in WinAnsi (Latin-1 plus €, typographic
 * quotes and dashes), any other character becomes "?". Enough for a quote, with no
 * dependency.
 */

import type { PdfImage } from './image.js'

export const A4 = { width: 595.28, height: 841.89 } as const

// Advance widths of Helvetica, in thousandths of the font size, for ASCII 32–126.
// prettier-ignore
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

// Characters outside Latin-1 that WinAnsi has, with their code.
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
}

/** One byte per character, in WinAnsi. */
function toWinAnsi(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 63
    if (code === 9) out += ' '
    else if (code >= 32 && code <= 126) out += ch
    else if (code >= 0xa0 && code <= 0xff) out += ch
    else if (WIN_ANSI_EXTRA[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[ch])
    else out += '?'
  }
  return out
}

function charWidth(code: number): number {
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32] ?? 556
  if (code === 0x96) return 556
  if (code === 0x97) return 1000
  if (code === 0x91 || code === 0x92) return 222
  if (code === 0x93 || code === 0x94) return 333
  if (code === 0xa0) return 278
  if (code >= 0xa0 && code <= 0xbf) return 400
  // Accented letters: about as wide as the base letter; capitals are wider.
  if (code >= 0xc0 && code <= 0xdf) return 722
  if (code >= 0xe0 && code <= 0xff) return code >= 0xec && code <= 0xef ? 278 : 556
  return 556
}

export interface TextStyle {
  size: number
  bold?: boolean
}

/** Width in points; bold is a little wider, so it is overestimated by 6%. */
export function textWidth(text: string, style: TextStyle): number {
  let units = 0
  for (const ch of toWinAnsi(text)) units += charWidth(ch.charCodeAt(0))
  return (units * style.size * (style.bold ? 1.06 : 1)) / 1000
}

/** Breaks text into lines no wider than `width`, keeping the paragraphs of the text. */
export function wrap(text: string, width: number, style: TextStyle): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/ +/)) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (textWidth(candidate, style) <= width) {
        line = candidate
        continue
      }
      if (line !== '') lines.push(line)
      // A word longer than the line is cut.
      let rest = word
      while (textWidth(rest, style) > width && rest.length > 1) {
        let cut = rest.length - 1
        while (cut > 1 && textWidth(rest.slice(0, cut), style) > width) cut--
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}

const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`)
const n = (value: number) => Number(value.toFixed(2)).toString()

export class PdfDocument {
  private readonly pages: string[][] = []
  private readonly images: PdfImage[] = []

  get pageCount(): number {
    return this.pages.length
  }

  addPage(): void {
    this.pages.push([])
  }

  private get ops(): string[] {
    const page = this.pages[this.pages.length - 1]
    if (!page) throw new Error('no page')
    return page
  }

  /** Text with its baseline at y (from the bottom of the page). */
  text(x: number, y: number, text: string, style: TextStyle, page?: number): void {
    const ops = page === undefined ? this.ops : this.pages[page]
    if (!ops) throw new Error('no page')
    ops.push(
      `BT /${style.bold ? 'F2' : 'F1'} ${n(style.size)} Tf ${n(x)} ${n(y)} Td (${escape(toWinAnsi(text))}) Tj ET`,
    )
  }

  textRight(right: number, y: number, text: string, style: TextStyle): void {
    this.text(right - textWidth(text, style), y, text, style)
  }

  /** Draws an image in the box with its bottom left corner at (x, y). */
  image(image: PdfImage, x: number, y: number, width: number, height: number): void {
    let index = this.images.indexOf(image)
    if (index < 0) index = this.images.push(image) - 1
    this.ops.push(`q ${n(width)} 0 0 ${n(height)} ${n(x)} ${n(y)} cm /Im${index} Do Q`)
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.ops.push(`${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`)
  }

  toBuffer(): Buffer {
    const objects: string[] = []
    const add = (body: string) => objects.push(body)
    add('<< /Type /Catalog /Pages 2 0 R >>')
    add('') // the page tree, once the page ids are known
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
    const binary = (data: Buffer) => data.toString('latin1')
    const imageIds = this.images.map((image) => {
      let smask = ''
      if (image.alpha) {
        add(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
            `/Length ${image.alpha.length} >>\nstream\n${binary(image.alpha)}\nendstream`,
        )
        smask = ` /SMask ${objects.length} 0 R`
      }
      const parms = image.decodeParms ? ` /DecodeParms ${image.decodeParms}` : ''
      add(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}` +
          `${parms}${smask} /Length ${image.data.length} >>\nstream\n${binary(image.data)}\nendstream`,
      )
      return objects.length
    })
    const xobjects = imageIds.length
      ? ` /XObject << ${imageIds.map((id, i) => `/Im${i} ${id} 0 R`).join(' ')} >>`
      : ''
    const pageIds: number[] = []
    for (const ops of this.pages) {
      const id = objects.length + 1
      pageIds.push(id)
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${id + 1} 0 R >>`,
      )
      const stream = ops.join('\n')
      add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    }
    objects[1] =
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
      `/Count ${pageIds.length} >>`
    // Every character is one byte (Latin-1), so string lengths are byte offsets.
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(out.length)
      out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(out, 'latin1')
  }
}
