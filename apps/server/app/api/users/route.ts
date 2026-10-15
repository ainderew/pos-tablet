// The organization's users: back-office sign-in (owners, admins, managers) and tablet PINs
import { NextResponse } from "next/server"
import { userStores, users } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { hashPassword, hashPin } from "@/lib/auth/passwords"
import { getDb } from "@/lib/db"
import { emailTaken, isUniqueViolation } from "@/lib/users/checks"
import { conflict, denied, invalidInput } from "@/lib/users/errors"
import { CreateUserSchema, fieldIssues } from "@/lib/users/input"
import { readJson } from "@/lib/http"
import { actorStores, orgUsers, publicUser, storesInScope } from "@/lib/users/lookup"
import { canSee, createDenial, worksInEveryStore } from "@/lib/users/permissions"

export async function GET(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const includeDeleted = new URL(request.url).searchParams.get("include_deleted") === "1"
  const all = await orgUsers(getDb(), auth.user.org_id, { includeDeleted })
  return NextResponse.json({ users: all.filter((u) => canSee(auth.user, u)).map((u) => publicUser(auth.user, u)) })
}

export async function POST(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const actor = auth.user
  const db = getDb()
  const body = await readJson(request, CreateUserSchema)
  if (!body.ok) return body.response
  const input = body.data

  const denial = createDenial(actor, input.role)
  if (denial) return denied(denial)

  // A manager's cashier works in the manager's stores unless they pick some of them
  const isManager = actor.role === "MANAGER"
  const requested = input.store_ids ?? (isManager ? await actorStores(db, actor) : [])
  const issues = fieldIssues({ role: input.role, email: input.email ?? null, hasPassword: !!input.password, storeIds: requested })
  if (isManager && requested.length === 0) issues.push({ path: "store_ids", message: "Choose at least one of your stores" })
  if (issues.length > 0) return invalidInput(issues)
  const storeIds = await storesInScope(db, actor, requested)
  if (!storeIds) return invalidInput([{ path: "store_ids", message: "Unknown store" }])

  const [passwordHash, pinHash] = await Promise.all([input.password ? hashPassword(input.password) : null, input.pin ? hashPin(input.pin) : null])
  let userId: string | null
  try {
    userId = await db.transaction(async (tx) => {
      if (input.email && (await emailTaken(tx, input.email))) return null
      const [user] = await tx
        .insert(users)
        .values({ org_id: actor.org_id, full_name: input.full_name, role: input.role, email: input.email ?? null, password_hash: passwordHash, pin_hash: pinHash })
        .returning({ id: users.id })
      if (!worksInEveryStore(input.role) && storeIds.length > 0) {
        await tx.insert(userStores).values(storeIds.map((store_id) => ({ user_id: user.id, store_id })))
      }
      return user.id
    })
  } catch (error) {
    if (isUniqueViolation(error, "users_email_idx")) return conflict("DUPLICATE_EMAIL")
    throw error
  }
  if (!userId) return conflict("DUPLICATE_EMAIL")
  const [user] = await orgUsers(db, actor.org_id, { userId })
  return NextResponse.json({ user: publicUser(actor, user) }, { status: 201 })
}
