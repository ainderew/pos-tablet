import { NextResponse } from "next/server"
import { and, eq, ilike, isNull, sql } from "drizzle-orm"
import { categories } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { categoryNameTaken, CategorySchema, NAME_INDEX, productCount } from "@/lib/catalog/categories"
import { isUniqueViolation } from "@/lib/catalog/db-errors"
import { containsPattern, flag } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { errorResponse, readJson } from "@/lib/http"

const duplicateName = () => errorResponse(409, "DUPLICATE_NAME", "A category with this name already exists")

export async function GET(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const url = new URL(request.url)
  const search = url.searchParams.get("search")?.trim()

  const rows = await getDb()
    .select({ category: categories, product_count: productCount() })
    .from(categories)
    .where(
      and(
        eq(categories.org_id, auth.user.org_id),
        flag(url, "include_deleted") ? undefined : isNull(categories.deleted_at),
        search ? ilike(categories.name, containsPattern(search)) : undefined
      )
    )
    .orderBy(sql`lower(${categories.name})`, categories.id)
  return NextResponse.json({ categories: rows.map((r) => ({ ...r.category, product_count: r.product_count })) })
}

export async function POST(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const body = await readJson(request, CategorySchema)
  if (!body.ok) return body.response
  const db = getDb()
  if (await categoryNameTaken(db, auth.user.org_id, body.data.name)) return duplicateName()

  try {
    const [category] = await db.insert(categories).values({ org_id: auth.user.org_id, name: body.data.name }).returning()
    return NextResponse.json({ category: { ...category, product_count: 0 } }, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err, NAME_INDEX)) return duplicateName() // created by someone else just now
    throw err
  }
}
