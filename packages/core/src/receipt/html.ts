// ReceiptDocument -> a static HTML document for thermal paper, ported from POS-bir's
// electron/receipt-template.js: every value is escaped, money never wraps, ~72mm wide content
// that shrinks to fit 58mm rolls, monospace, no backgrounds, and a CSP that blocks scripts and
// all network access. Pure string building: no DOM.
import { formatReceiptMoney, formatReceiptQuantity } from "./model"
import type { ReceiptDocument, ReceiptItemLine, ReceiptRow } from "./model"

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const STYLES = [
  "@page{margin:0}",
  "*{box-sizing:border-box}",
  "html,body{margin:0;padding:0;color:#000}",
  // 72mm fits 80mm rolls; max-width lets 58mm rolls (~48mm printable) shrink to fit.
  'body{width:72mm;max-width:100%;font-family:"Courier New",Courier,monospace;font-size:12px;line-height:1.25}',
  ".c{text-align:center}.l{text-align:left}.r{text-align:right;white-space:nowrap;padding-left:4px}",
  ".b{font-weight:bold}.lg{font-size:14px}",
  ".w{white-space:normal;word-break:break-word}.name{word-break:break-word}.ind{padding-left:8px}",
  "hr{border:0;border-top:1px dashed #000;margin:4px 0}",
  "table{width:100%;border-collapse:collapse}td{padding:0;vertical-align:top}",
].join("")

const CSP = "default-src 'none'; style-src 'unsafe-inline'"

const line = (text: string, cls = "c") => (text ? `<div class="${cls}">${escapeHtml(text)}</div>` : "")
const rule = () => "<hr>"
const section = (html: string) => (html ? rule() + html : "")

function row(r: ReceiptRow): string {
  const isMoney = typeof r.value === "number"
  const shown = isMoney ? formatReceiptMoney(r.value as number) : String(r.value)
  if (shown === "") return ""
  const cls = r.emphasis ? ' class="b lg"' : ""
  // Money never wraps; free text (names, references) may wrap on 58mm paper.
  const valueCls = isMoney ? "r" : "r w"
  return `<tr${cls}><td>${escapeHtml(r.label)}</td><td class="${valueCls}">${escapeHtml(shown)}</td></tr>`
}

function table(rows: ReceiptRow[]): string {
  const body = rows.map(row).join("")
  return body ? `<table>${body}</table>` : ""
}

function items(lines: ReceiptItemLine[]): string {
  if (lines.length === 0) return ""
  const rows = lines.map((item) => {
    const qty = formatReceiptQuantity(item.quantity)
    const unit = item.unitPrice === null ? "" : formatReceiptMoney(item.unitPrice)
    const detail = unit ? `${qty} x ${unit}` : qty
    return (
      `<tr><td colspan="2" class="name">${escapeHtml(item.name)}</td></tr>` +
      `<tr><td class="ind">${escapeHtml(detail)}</td>` +
      `<td class="r">${escapeHtml(formatReceiptMoney(item.lineTotal))}</td></tr>`
    )
  })
  return `<table>${rows.join("")}</table>`
}

function body(doc: ReceiptDocument): string {
  return [
    doc.header.map((h) => line(h.text, h.emphasis ? "c b lg" : "c")).join(""),
    rule(),
    doc.banner ? line(doc.banner, "c b lg") : "",
    line(doc.title, "c b"),
    table(doc.meta),
    doc.notes.map((n) => line(n, "l")).join(""),
    section(items(doc.items)),
    rule(),
    table(doc.totals),
    section(table(doc.vatBreakdown)),
    section(table(doc.payment)),
    doc.footer.length ? rule() + doc.footer.map((l) => line(l)).join("") : "",
  ].join("")
}

/** A complete, static HTML document for printing or a WebView preview. */
export function renderReceiptHtml(doc: ReceiptDocument): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    // Static document: no scripts, no network, inline styles only.
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<title>Receipt</title><style>${STYLES}</style></head><body>` +
    body(doc) +
    "</body></html>"
  )
}
