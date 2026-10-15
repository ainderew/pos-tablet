import { NextResponse } from "next/server"
import { and, eq, ilike, isNull, or } from "drizzle-orm"
import { products } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { isUniqueViolation } from "@/lib/catalog/db-errors"
import { activeCategoryLocked, BARCODE_INDEX, barcodeTaken, mergeProduct, ProductCreateSchema, productOrder } from "@/lib/catalog/products"
import { isLowStock, stockLevels } from "@/lib/catalog/stock"
import { containsPattern, flag, invalidInput } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { errorResponse, notFound, readJson } from "@/lib/http"
import { isUuid, storeForUser } from "@/lib/stores"

/** The organization's catalog; with ?store_id=, each product also has that store's stock */
export async function GET(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const url = new URL(request.url)
  const search = url.searchParams.get("search")?.trim()
  const categoryId = url.searchParams.get("category_id")
  const storeId = url.searchParams.get("store_id")

  const store = storeId !== null ? await storeForUser(db, auth.user, storeId) : null
  if (storeId !== null && !store) return notFound("Store not found")
  if (categoryId && !isUuid(categoryId)) return NextResponse.json({ products: [] }) // matches nothing

  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.org_id, auth.user.org_id),
        flag(url, "include_deleted") ? undefined : isNull(products.deleted_at),
        categoryId ? eq(products.category_id, categoryId) : undefined,
        search ? or(ilike(products.name, containsPattern(search)), ilike(products.barcode, containsPattern(search))) : undefined
      )
    )
    .orderBy(...productOrder)
  if (!store) return NextResponse.json({ products: rows })

  const stock = await stockLevels(db, store.id)
  return NextResponse.json({
    products: rows.map((p) => {
      const level = stock.get(p.id) ?? 0
      return { ...p, stock_level: level, is_low_stock: isLowStock(p, level) }
    }),
  })
}

export async function POST(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const body = await readJson(request, ProductCreateSchema)
  if (!body.ok) return body.response
  const merged = mergeProduct(null, body.data)
  if (!merged.ok) return invalidInput(merged.issues)
  const values = merged.values
  const orgId = auth.user.org_id
  const db = getDb()

  const duplicate = () => errorResponse(409, "DUPLICATE_BARCODE", "Another product already uses this barcode")
  if (values.barcode && (await barcodeTaken(db, orgId, values.barcode))) return duplicate()
  try {
    const product = await db.transaction(async (tx) => {
      if (values.category_id && !(await activeCategoryLocked(tx, orgId, values.category_id))) return null
      const [row] = await tx
        .insert(products)
        .values({ ...values, org_id: orgId })
        .returning()
      return row
    })
    if (!product) return invalidInput([{ path: "category_id", message: "Category not found" }])
    return NextResponse.json({ product }, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err, BARCODE_INDEX)) return duplicate() // saved by someone else just now
    throw err
  }
}
