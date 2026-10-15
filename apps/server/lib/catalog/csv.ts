// POS-bir's product CSV: the same columns in the same order, so a file exported from either app
// imports into the other. stock_level is per store here, so it is only exported (and imported) for
// one store at a time (?store_id=).

export const CSV_HEADERS = [
  "name",
  "barcode",
  "selling_price",
  "cost_price",
  "stock_level",
  "unit_type",
  "low_stock_threshold",
  "notify_low_stock",
  "category",
  "tax_category",
  "supplier_type",
  "is_promo",
  "promo_price",
  "wholesale_price",
  "wholesale_threshold",
  "updated_at",
] as const

export const REQUIRED_COLUMNS = ["name", "selling_price", "cost_price", "unit_type"] as const

/** Quote a field when it holds a comma, quote or line break (POS-bir's escaping) */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  const str = value instanceof Date ? value.toISOString() : String(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

export const csvLine = (values: unknown[]) => values.map(csvField).join(",")

export type CsvRecord = { line: number; fields: string[] }

/**
 * Parse CSV text into records, each with the file line it starts on (1 = the header). Fields are
 * trimmed as POS-bir does; quoted fields may contain commas, "" and line breaks. Blank lines and
 * rows of only empty fields (a spreadsheet's trailing ",,,,") are left out. A UTF-8 BOM (Excel's
 * "CSV UTF-8") is ignored.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: CsvRecord[] = []
  let fields: string[] = []
  let current = ""
  let inQuotes = false
  let line = 1
  let recordLine = 1

  const endField = () => {
    fields.push(current.trim())
    current = ""
  }
  const endRecord = () => {
    endField()
    if (fields.some((f) => f !== "")) records.push({ line: recordLine, fields })
    fields = []
  }

  for (let i = 0; i < src.length; i++) {
    const char = src[i]
    if (inQuotes) {
      if (char === '"' && src[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        if (char === "\n") line++
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      endField()
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && src[i + 1] === "\n") i++
      endRecord()
      line++
      recordLine = line
    } else {
      current += char
    }
  }
  if (current !== "" || fields.length > 0) endRecord()
  return records
}

/** POS-bir's number parsing: currency signs, thousands separators and spaces are ignored */
export function parseCsvNumber(value: string): number | null {
  const cleaned = value.replace(/[₱$,\s]/g, "")
  if (cleaned === "") return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

/** POS-bir writes 1/0; "true"/"false" and "yes"/"no" are accepted too. Blank is false. */
export function parseCsvBoolean(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "n") return false
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true
  return null
}

// "2026-09-01 10:00:00": POS-bir's SQLite datetime('now'), which is UTC without saying so
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** updated_at as either app writes it: ISO 8601 (this server) or SQLite's UTC datetime (POS-bir) */
export function parseCsvTimestamp(value: string): Date | null {
  const v = value.trim()
  const date = new Date(ZONELESS.test(v) ? `${v.replace(" ", "T")}Z` : v)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "vat exempt" / "Vat-Exempt" -> "VAT_EXEMPT" */
export const enumCell = (value: string) => value.trim().toUpperCase().replace(/[\s-]+/g, "_")
