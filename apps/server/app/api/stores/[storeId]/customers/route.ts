// A store's store-credit customers, each with their balance (the sum of their ledger entries)
import { NextResponse } from "next/server"
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { customers } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { customerBalance } from "@/lib/customers/balance"
import { CREDIT_STATUSES, CreateCustomerSchema } from "@/lib/customers/input"
import { containsPattern } from "@/lib/customers/lookup"
import { getDb } from "@/lib/db"
import { errorResponse, notFound, readJson } from "@/lib/http"
import { storeForUser } from "@/lib/stores"

type Params = { params: Promise<{ storeId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")

  const query = new URL(request.url).searchParams
  const search = query.get("search")?.trim().slice(0, 100)
  const status = query.get("status") || null
  if (status && !(CREDIT_STATUSES as readonly string[]).includes(status)) {
    return errorResponse(400, "INVALID_INPUT", "Some fields are invalid", {
      issues: [{ path: "status", message: `status must be one of ${CREDIT_STATUSES.join(", ")}` }],
    })
  }

  const where: SQL[] = [eq(customers.store_id, store.id)]
  if (query.get("include_deleted") !== "1") where.push(isNull(customers.deleted_at))
  if (status) where.push(eq(customers.credit_status, status))
  if (search) {
    const pattern = containsPattern(search)
    where.push(or(ilike(customers.full_name, pattern), ilike(customers.phone_number, pattern), ilike(customers.email, pattern))!)
  }
  const rows = await db
    .select({ customer: customers, balance: customerBalance(customers.id) })
    .from(customers)
    .where(and(...where))
    .orderBy(sql`lower(${customers.full_name})`, asc(customers.id))
  return NextResponse.json({ customers: rows.map((r) => ({ ...r.customer, balance: r.balance })) })
}

export async function POST(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const body = await readJson(request, CreateCustomerSchema)
  if (!body.ok) return body.response

  const [customer] = await db
    .insert(customers)
    .values({
      store_id: store.id,
      full_name: body.data.full_name,
      phone_number: body.data.phone_number ?? null,
      email: body.data.email ?? null,
      address: body.data.address ?? null,
      credit_limit: body.data.credit_limit ?? 0,
    })
    .returning()
  return NextResponse.json({ customer: { ...customer, balance: 0 } }, { status: 201 })
}
