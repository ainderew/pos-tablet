// ReceiptDocument -> ESC/POS bytes for 58 mm (32 columns) and 80 mm (48 columns) thermal printers,
// Font A. Same content and order as renderReceiptHtml. Pure TS: no TextEncoder, DOM or Node APIs.
//
// Text is first reduced to characters the selected code page can print (one byte each), then laid
// out, so every line is measured exactly as it prints. User text can never emit control bytes:
// anything outside the code page becomes a fallback or "?".
import { formatReceiptMoney, formatReceiptQuantity } from "./model"
import type { ReceiptDocument, ReceiptRow } from "./model"

export type EscPosPaperWidth = 58 | 80
export type EscPosCodePage = "cp437" | "wpc1252"

export interface EscPosOptions {
  paperWidth: EscPosPaperWidth
  /** Partial cut (GS V 66 0) after the feed. Default false: many 58 mm printers have no cutter. */
  cut?: boolean
  /** Characters per line; default 32 at 58 mm and 48 at 80 mm (Font A). Some 80 mm heads fit 42. */
  columns?: number
  /** Default "cp437" */
  codePage?: EscPosCodePage
  /** ESC t number for the code page, if the printer numbers it differently (Epson: cp437 0, wpc1252 16) */
  codePageNumber?: number
  /** Lines fed after the footer so it clears the tear bar / cutter. Default 4. */
  feedLines?: number
  /** Send FS . first: cancels Chinese (Kanji) mode, which some printers default to and which garbles bytes >= 0x80 */
  cancelKanji?: boolean
}

export const ESC_POS_COLUMNS: Record<EscPosPaperWidth, number> = { 58: 32, 80: 48 }

const ESC = 0x1b
const GS = 0x1d
const FS = 0x1c
const LF = 0x0a

type Align = 0 | 1 // ESC a n: left, centre
const LEFT: Align = 0
const CENTER: Align = 1
const NORMAL = 0x00
const DOUBLE_HEIGHT = 0x01
const DOUBLE_SIZE = 0x11 // double width and height

// ---------------------------------------------------------------------------
// Code pages: Unicode character -> byte, for bytes 0x80-0xFF

function upperHalf(chars: string): Map<string, number> {
  const map = new Map<string, number>()
  Array.from(chars).forEach((ch, i) => {
    if (ch !== "\0") map.set(ch, 0x80 + i)
  })
  return map
}

// 0xFF is a no-break space; it is printed as a plain space instead
const CP437 = upperHalf(
  "ÇüéâäàåçêëèïîìÄÅ" +
    "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
    "áíóúñÑªº¿⌐¬½¼¡«»" +
    "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
    "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
    "αßΓπΣσµτΦΘΩδ∞φε∩" +
    "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\0"
)

// 0x80-0x9F as Windows-1252, then Latin-1 (except no-break space and soft hyphen)
const WPC1252 = upperHalf(
  "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0" +
    "\0‘’“”•–—˜™š›œ\0žŸ" +
    Array.from({ length: 0x60 }, (_, i) => (i === 0 || i === 0x0d ? "\0" : String.fromCharCode(0xa0 + i))).join("")
)

const CODE_PAGES: Record<EscPosCodePage, { escT: number; chars: Map<string, number> }> = {
  cp437: { escT: 0, chars: CP437 },
  wpc1252: { escT: 16, chars: WPC1252 },
}

/** Used when the code page lacks a character (and stripping its accent doesn't help) */
const FALLBACK: Record<string, string> = {
  "₱": "P",
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "…": "...",
  "•": "*",
  "×": "x",
  "€": "EUR",
  "™": "TM", "©": "(C)", "®": "(R)",
  "‹": "<", "›": ">", "«": "<<", "»": ">>",
  "Æ": "AE", "æ": "ae", "Œ": "OE", "œ": "oe", "Ø": "O", "ø": "o", "ß": "ss",
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i",
  "¹": "1", "²": "2", "³": "3", "¼": "1/4", "½": "1/2", "¾": "3/4",
}

const WHITESPACE = /[\t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/
const INVISIBLE = /[\u00ad\u034f\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/
const COMBINING = /[\u0300-\u036f]/g

const isAsciiPrintable = (code: number) => code >= 0x20 && code < 0x7f

/**
 * Reduces text to what the code page prints, one byte per character: ASCII as-is, code-page
 * characters as-is, then fallbacks ("₱" -> "P", curly quotes -> straight), then the letter without
 * its accent, else "?". Control characters never get through. Whitespace runs collapse to one space.
 */
export function toPrintableText(text: string, codePage: EscPosCodePage = "cp437"): string {
  const table = CODE_PAGES[codePage].chars
  const printable = (ch: string) => isAsciiPrintable(ch.charCodeAt(0)) || table.has(ch)
  let out = ""
  for (const ch of String(text ?? "").normalize("NFC")) {
    if (isAsciiPrintable(ch.charCodeAt(0))) out += ch
    else if (WHITESPACE.test(ch)) out += " "
    else if (INVISIBLE.test(ch)) continue
    else if (table.has(ch)) out += ch
    else if (FALLBACK[ch] !== undefined) out += FALLBACK[ch]
    else {
      const bare = ch.normalize("NFD").replace(COMBINING, "")
      out += bare !== "" && Array.from(bare).every(printable) ? bare : "?"
    }
  }
  return out.replace(/ {2,}/g, " ").trim()
}

// ---------------------------------------------------------------------------
// Layout (on printable text, so .length is the printed width in columns)

interface PrintLine {
  text: string
  align: Align
  bold: boolean
  size: number
}

/** Word-wraps to `width` columns; words longer than a line are split. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ""
  for (let word of text.split(" ")) {
    while (word.length > width) {
      if (current) lines.push(current)
      current = ""
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!word) continue
    if (!current) current = word
    else if (current.length + 1 + word.length <= width) current += " " + word
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

const spread = (left: string, right: string, width: number) =>
  left + " ".repeat(Math.max(1, width - left.length - right.length)) + right

const MIN_LABEL_WIDTH = 6
const MIN_VALUE_WIDTH = 8

/** Label on the left, value right-aligned. Amounts never split; text values wrap under themselves. */
function twoColumns(label: string, value: string, width: number, valueWraps: boolean): string[] {
  if (!label) return wrap(value, width).map((v) => v.padStart(width))
  if (label.length + 1 + value.length <= width) return [spread(label, value, width)]
  if (!valueWraps && width - value.length - 1 >= MIN_LABEL_WIDTH) {
    const labels = wrap(label, width - value.length - 1)
    return [spread(labels[0], value, width), ...labels.slice(1)]
  }
  if (valueWraps && width - label.length - 1 >= MIN_VALUE_WIDTH) {
    const values = wrap(value, width - label.length - 1)
    return [spread(label, values[0], width), ...values.slice(1).map((v) => v.padStart(width))]
  }
  return [...wrap(label, width), ...wrap(value, width).map((v) => v.padStart(width))]
}

function layout(doc: ReceiptDocument, width: number, codePage: EscPosCodePage): PrintLine[] {
  const out: PrintLine[] = []
  const p = (text: string) => toPrintableText(text, codePage)
  const push = (lines: string[], align: Align, bold = false, size = NORMAL) => {
    for (const text of lines) out.push({ text, align, bold, size })
  }
  const centered = (text: string, bold = false, size = NORMAL) => {
    const columns = size & 0x10 ? Math.floor(width / 2) : width
    push(wrap(p(text), columns), CENTER, bold, size)
  }
  const rule = () => push(["-".repeat(width)], LEFT)
  const rows = (list: ReceiptRow[]) => {
    for (const r of list) {
      const isMoney = typeof r.value === "number"
      const value = isMoney ? formatReceiptMoney(r.value as number) : p(String(r.value))
      if (value === "") continue
      const lines = twoColumns(p(r.label), value, width, !isMoney)
      push(lines, LEFT, !!r.emphasis, r.emphasis ? DOUBLE_HEIGHT : NORMAL)
    }
  }
  const section = (list: ReceiptRow[]) => {
    if (list.some((r) => (typeof r.value === "number" ? formatReceiptMoney(r.value) : p(r.value)) !== "")) {
      rule()
      rows(list)
    }
  }

  for (const h of doc.header) {
    if (h.emphasis) centered(h.text, true, DOUBLE_HEIGHT)
    else centered(h.text)
  }
  rule()
  if (doc.banner) {
    const banner = p(doc.banner)
    centered(banner, true, banner.length * 2 <= width ? DOUBLE_SIZE : DOUBLE_HEIGHT)
  }
  centered(doc.title, true, DOUBLE_HEIGHT)
  rows(doc.meta)
  for (const note of doc.notes) push(wrap(p(note), width), LEFT)

  if (doc.items.length) {
    rule()
    for (const item of doc.items) {
      push(wrap(p(item.name), width), LEFT)
      const qty = formatReceiptQuantity(item.quantity)
      const unit = item.unitPrice === null ? "" : formatReceiptMoney(item.unitPrice)
      const detail = "  " + (unit ? `${qty} x ${unit}` : qty)
      const total = formatReceiptMoney(item.lineTotal)
      if (detail.length + 1 + total.length <= width) push([spread(detail, total, width)], LEFT)
      else push([...wrap(detail.trim(), width), total.padStart(width)], LEFT)
    }
  }

  rule()
  rows(doc.totals)
  section(doc.vatBreakdown)
  section(doc.payment)

  const footer = doc.footer.map(p).filter(Boolean)
  if (footer.length) {
    rule()
    for (const l of footer) centered(l)
  }
  return out
}

// ---------------------------------------------------------------------------
// Encoding

/** Renders the receipt as ESC/POS: init, code page, the lines, a feed and an optional cut. */
export function renderReceiptEscPos(doc: ReceiptDocument, options: EscPosOptions): Uint8Array {
  const width = options.columns ?? ESC_POS_COLUMNS[options.paperWidth]
  if (!Number.isInteger(width) || width < 16 || width > 255) {
    throw new RangeError(`renderReceiptEscPos: unsupported paper width/columns (${options.paperWidth}/${options.columns})`)
  }
  const codePage = options.codePage ?? "cp437"
  const { escT, chars } = CODE_PAGES[codePage]
  const escTNumber = options.codePageNumber ?? escT
  const feedLines = Math.min(255, Math.max(0, Math.floor(options.feedLines ?? 4)))

  const bytes: number[] = [ESC, 0x40] // ESC @: initialise
  if (options.cancelKanji) bytes.push(FS, 0x2e) // FS .
  bytes.push(ESC, 0x74, escTNumber & 0xff) // ESC t n: code page

  let align = LEFT
  let bold = false
  let size = NORMAL
  const setStyle = (next: { align: Align; bold: boolean; size: number }) => {
    if (next.align !== align) bytes.push(ESC, 0x61, (align = next.align))
    if (next.bold !== bold) bytes.push(ESC, 0x45, (bold = next.bold) ? 1 : 0)
    if (next.size !== size) bytes.push(GS, 0x21, (size = next.size))
  }

  for (const l of layout(doc, width, codePage)) {
    setStyle(l)
    for (const ch of l.text) {
      const code = ch.charCodeAt(0)
      bytes.push(isAsciiPrintable(code) ? code : (chars.get(ch) ?? 0x3f))
    }
    bytes.push(LF)
  }

  setStyle({ align: LEFT, bold: false, size: NORMAL })
  if (feedLines) bytes.push(ESC, 0x64, feedLines) // ESC d n: print and feed n lines
  if (options.cut) bytes.push(GS, 0x56, 0x42, 0x00) // GS V 66 0: feed to the cutter, partial cut
  return new Uint8Array(bytes)
}
