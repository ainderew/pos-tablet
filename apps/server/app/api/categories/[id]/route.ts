import { NextResponse } from "next/server"
import { and, count, eq, isNull } from "drizzle-orm"
import { categories, products } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { categoryNameTaken, CategorySchema, categoryWithCount, NAME_INDEX } from "@/lib/catalog/categories"
import { isUniqueViolation } from "@/lib/catalog/db-errors"
import { getDb } from "@/lib/db"
import { errorResponse, notFound, readJson } from "@/lib/http"
import { isUuid } from "@/lib/stores"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const { id } = await params
  const db = getDb()
  const orgId = auth.user.org_id
  if (!isUuid(id) || !(await categoryWithCount(db, orgId, id))) return notFound("Category not found")
  const body = await readJson(request, CategorySchema)
  if (!body.ok) return body.response

  const duplicate = () => errorResponse(409, "DUPLICATE_NAME", "A category with this name already exists")
  if (await categoryNameTaken(db, orgId, body.data.name, id)) return duplicate()
  try {
    const [updated] = await db
      .update(categories)
      .set({ name: body.data.name })
      .where(and(eq(categories.id, id), eq(categories.org_id, orgId), isNull(categories.deleted_at)))
      .returning({ id: categories.id })
    if (!updated) return notFound("Category not found")
  } catch (err) {
    if (isUniqueViolation(err, NAME_INDEX)) return duplicate()
    throw err
  }
  return NextResponse.json({ category: await categoryWithCount(db, orgId, id) })
}

/** Soft delete, refused while active products use the category */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUuid(id)) return notFound("Category not found")
  const orgId = auth.user.org_id

  const outcome = await getDb().transaction(async (tx) => {
    // Lock the category first: a product being saved into it concurrently share-locks it, so the count
    // below can't miss that product
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.org_id, orgId), isNull(categories.deleted_at)))
      .for("update")
    if (!category) return "not_found" as const
    const [{ n }] = await tx
      .select({ n: count() })
      .from(products)
      .where(and(eq(products.category_id, id), isNull(products.deleted_at)))
    if (n > 0) return n
    await tx.update(categories).set({ deleted_at: new Date() }).where(eq(categories.id, id))
    return "deleted" as const
  })
  if (outcome === "not_found") return notFound("Category not found")
  if (typeof outcome === "number") {
    const what = outcome === 1 ? "1 product uses" : `${outcome} products use`
    return errorResponse(409, "CATEGORY_IN_USE", `${what} this category. Move or delete them first.`)
  }
  return NextResponse.json({ ok: true })
}
