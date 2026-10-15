import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { stores } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { storePatchIssues, StorePatchSchema } from "@/lib/catalog/stores"
import { definedOnly, invalidInput } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { notFound, readJson } from "@/lib/http"
import { storeForUser } from "@/lib/stores"

type Params = { params: Promise<{ storeId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const store = await storeForUser(getDb(), auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  return NextResponse.json({ store })
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: ["OWNER", "ADMIN"] })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const body = await readJson(request, StorePatchSchema)
  if (!body.ok) return body.response

  const changes = definedOnly(body.data)
  if (Object.keys(changes).length === 0) return invalidInput([{ path: "", message: "Nothing to update" }])
  const issues = storePatchIssues(store, changes)
  if (issues.length) return invalidInput(issues)

  const [updated] = await db.update(stores).set(changes).where(eq(stores.id, store.id)).returning()
  return NextResponse.json({ store: updated })
}
