import { NextResponse } from "next/server"
import { and, asc, eq, ilike, inArray, isNull, or } from "drizzle-orm"
import { stores } from "@pos/db"
import { requireUser } from "@/lib/auth/guard"
import { StoreCreateSchema } from "@/lib/catalog/stores"
import { containsPattern, flag } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { readJson } from "@/lib/http"

/** The stores the caller may work in: every store of the organization for owners and admins */
export async function GET(request: Request) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const { user } = auth
  const url = new URL(request.url)
  const search = url.searchParams.get("search")?.trim()
  if (user.storeIds !== "ALL" && user.storeIds.length === 0) return NextResponse.json({ stores: [] })

  const rows = await getDb()
    .select()
    .from(stores)
    .where(
      and(
        eq(stores.org_id, user.org_id),
        user.storeIds === "ALL" ? undefined : inArray(stores.id, user.storeIds),
        flag(url, "include_deleted") ? undefined : isNull(stores.deleted_at),
        search ? or(ilike(stores.name, containsPattern(search)), ilike(stores.business_name, containsPattern(search))) : undefined
      )
    )
    .orderBy(asc(stores.created_at), asc(stores.id))
  return NextResponse.json({ stores: rows })
}

export async function POST(request: Request) {
  const auth = await requireUser(request, { roles: ["OWNER", "ADMIN"] })
  if (!auth.ok) return auth.response
  const body = await readJson(request, StoreCreateSchema)
  if (!body.ok) return body.response

  const [store] = await getDb()
    .insert(stores)
    .values({
      org_id: auth.user.org_id,
      name: body.data.name,
      business_name: body.data.business_name ?? null,
      business_address: body.data.business_address ?? null,
      business_tin: body.data.business_tin ?? null,
    })
    .returning()
  return NextResponse.json({ store }, { status: 201 })
}
