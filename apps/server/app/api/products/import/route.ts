// Imports POS-bir's product CSV (multipart/form-data, field "file"); see lib/catalog/import.ts
import { NextResponse } from "next/server"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { parseCsv, REQUIRED_COLUMNS } from "@/lib/catalog/csv"
import { importProducts } from "@/lib/catalog/import"
import { invalidInput } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { notFound } from "@/lib/http"
import { storeForUser } from "@/lib/stores"

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 20_000

export async function POST(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const storeId = new URL(request.url).searchParams.get("store_id")
  const store = storeId !== null ? await storeForUser(db, auth.user, storeId) : null
  if (storeId !== null && !store) return notFound("Store not found")

  let file: FormDataEntryValue | null = null
  try {
    file = (await request.formData()).get("file")
  } catch {
    file = null
  }
  if (!file || typeof file === "string") return invalidInput([{ path: "file", message: "Attach the CSV as multipart/form-data field \"file\"" }])
  if (file.size > MAX_FILE_BYTES) return invalidInput([{ path: "file", message: "The file is larger than 5 MB" }])

  const records = parseCsv(await file.text())
  if (records.length < 2) return invalidInput([{ path: "file", message: "CSV file is empty or has no data rows" }])
  if (records.length - 1 > MAX_ROWS) return invalidInput([{ path: "file", message: `At most ${MAX_ROWS} rows per file` }])
  const headers = records[0].fields.map((h) => h.toLowerCase().trim())
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c))
  if (missing.length) return invalidInput(missing.map((c) => ({ path: "file", message: `Missing required column: ${c}` })))
  if (headers.includes("stock_level") && !store) {
    return invalidInput([{ path: "store_id", message: "The CSV has a stock_level column: choose the store it counts (?store_id=)" }])
  }

  const result = await importProducts(db, {
    orgId: auth.user.org_id,
    userId: auth.user.id,
    storeId: store?.id ?? null,
    headers,
    records: records.slice(1),
  })
  return NextResponse.json(result)
}
