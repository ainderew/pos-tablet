// One-time setup: creates the organization, its first store and the owner account. Needs the
// SETUP_TOKEN from the server's .env, and only works while there are no users at all.
import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { count, sql } from "drizzle-orm"
import { z } from "zod"
import { organizations, stores, users } from "@pos/db"
import { isSameOrigin } from "@/lib/auth/guard"
import { hashPassword, hashPin, MIN_PASSWORD_LENGTH, PIN_PATTERN } from "@/lib/auth/passwords"
import { getDb } from "@/lib/db"
import { errorResponse, readJson } from "@/lib/http"

const SetupSchema = z.object({
  setup_token: z.string().min(1),
  organization_name: z.string().trim().min(1).max(120),
  store_name: z.string().trim().min(1).max(120),
  owner_name: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  pin: z.string().regex(PIN_PATTERN).optional(),
})

const tokenMatches = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.SETUP_TOKEN
  if (!expected) return errorResponse(404, "NOT_FOUND", "Not found")
  if (!isSameOrigin(request)) return errorResponse(403, "CROSS_SITE", "Cross-site request refused")
  const body = await readJson(request, SetupSchema)
  if (!body.ok) return body.response
  if (!tokenMatches(body.data.setup_token, expected)) return errorResponse(403, "FORBIDDEN", "Wrong setup token")

  const db = getDb()
  const result = await db.transaction(async (tx) => {
    // Two setups at once (a double submit) must not both create an organization
    await tx.execute(sql`select pg_advisory_xact_lock(7250421)`)
    const [{ n }] = await tx.select({ n: count() }).from(users)
    if (n > 0) return null
    const [org] = await tx.insert(organizations).values({ name: body.data.organization_name }).returning()
    const [store] = await tx.insert(stores).values({ org_id: org.id, name: body.data.store_name, business_name: body.data.organization_name }).returning()
    const [owner] = await tx
      .insert(users)
      .values({
        org_id: org.id,
        full_name: body.data.owner_name,
        role: "OWNER",
        email: body.data.email.toLowerCase(),
        password_hash: await hashPassword(body.data.password),
        pin_hash: body.data.pin ? await hashPin(body.data.pin) : null,
      })
      .returning({ id: users.id })
    return { organization_id: org.id, store_id: store.id, owner_id: owner.id }
  })
  if (!result) return errorResponse(409, "ALREADY_SET_UP", "Setup has already been done")
  return NextResponse.json(result, { status: 201 })
}
