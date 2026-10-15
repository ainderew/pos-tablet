import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { products } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { isUniqueViolation } from "@/lib/catalog/db-errors"
import { activeCategoryLocked, BARCODE_INDEX, barcodeTaken, mergeProduct, productInOrg, ProductPatchSchema, productValuesOf } from "@/lib/catalog/products"
import { definedOnly, flag, invalidInput } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { errorResponse, notFound, readJson } from "@/lib/http"
import { isUuid } from "@/lib/stores"

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const { id } = await params
  const includeDeleted = flag(new URL(request.url), "include_deleted")
  const product = isUuid(id) ? await productInOrg(getDb(), auth.user.org_id, id, { includeDeleted }) : null
  if (!product) return notFound("Product not found")
  return NextResponse.json({ product })
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const { id } = await params
  const db = getDb()
  const orgId = auth.user.org_id
  const existing = isUuid(id) ? await productInOrg(db, orgId, id) : null
  if (!existing) return notFound("Product not found")
  const body = await readJson(request, ProductPatchSchema)
  if (!body.ok) return body.response

  const changes = definedOnly(body.data)
  if (Object.keys(changes).length === 0) return invalidInput([{ path: "", message: "Nothing to update" }])
  const merged = mergeProduct(productValuesOf(existing), changes)
  if (!merged.ok) return invalidInput(merged.issues)
  const values = merged.values

  const duplicate = () => errorResponse(409, "DUPLICATE_BARCODE", "Another product already uses this barcode")
  if (values.barcode && (await barcodeTaken(db, orgId, values.barcode, id))) return duplicate()
  try {
    const outcome = await db.transaction(async (tx) => {
      const newCategory = values.category_id && values.category_id !== existing.category_id
      if (newCategory && !(await activeCategoryLocked(tx, orgId, values.category_id!))) return "bad_category" as const
      const [row] = await tx
        .update(products)
        .set(values)
        .where(and(eq(products.id, id), eq(products.org_id, orgId), isNull(products.deleted_at)))
        .returning()
      return row ?? null
    })
    if (outcome === "bad_category") return invalidInput([{ path: "category_id", message: "Category not found" }])
    if (!outcome) return notFound("Product not found")
    return NextResponse.json({ product: outcome })
  } catch (err) {
    if (isUniqueViolation(err, BARCODE_INDEX)) return duplicate()
    throw err
  }
}

/** Soft delete: the product syncs down as deleted, and its barcode is free again */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUuid(id)) return notFound("Product not found")
  const [deleted] = await getDb()
    .update(products)
    .set({ deleted_at: new Date() })
    .where(and(eq(products.id, id), eq(products.org_id, auth.user.org_id), isNull(products.deleted_at)))
    .returning({ id: products.id })
  if (!deleted) return notFound("Product not found")
  return NextResponse.json({ ok: true })
}
