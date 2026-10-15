// Editing and removing a user. Deactivating, deleting or a new password signs them out of the back office.
import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { userStores, users } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { hashPassword, hashPin } from "@/lib/auth/passwords"
import { destroyUserSessions } from "@/lib/auth/session"
import { getDb } from "@/lib/db"
import { notFound, readJson } from "@/lib/http"
import { anotherActiveOwner, emailTaken, isUniqueViolation } from "@/lib/users/checks"
import { conflict, denied, invalidInput } from "@/lib/users/errors"
import type { UserConflict } from "@/lib/users/errors"
import { fieldIssues, UpdateUserSchema } from "@/lib/users/input"
import { orgUsers, publicUser, storesInScope, userForActor } from "@/lib/users/lookup"
import { deleteDenial, sameStores, updateDenial, worksInEveryStore } from "@/lib/users/permissions"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const actor = auth.user
  const db = getDb()
  const target = await userForActor(db, actor, (await params).id)
  if (!target) return notFound("User not found")
  const body = await readJson(request, UpdateUserSchema)
  if (!body.ok) return body.response
  const input = body.data

  const denial = updateDenial(actor, target, input)
  if (denial) return denied(denial)

  // The user as they'll be saved; a cashier never keeps a password
  const role = input.role ?? target.role
  const email = input.email !== undefined ? input.email : target.email
  const hasPassword = input.password !== undefined ? input.password !== null : role !== "CASHIER" && target.password_hash !== null
  const issues = fieldIssues({ role, email, hasPassword, storeIds: input.store_ids })
  if (actor.role === "MANAGER" && input.store_ids?.length === 0) issues.push({ path: "store_ids", message: "Choose at least one of your stores" })
  if (issues.length > 0) return invalidInput(issues)
  let storeIds: string[] | null = null
  if (input.store_ids !== undefined && !worksInEveryStore(role)) {
    storeIds = await storesInScope(db, actor, input.store_ids)
    if (!storeIds) return invalidInput([{ path: "store_ids", message: "Unknown store" }])
  }

  const roleChanged = role !== target.role
  const removesOwner = target.role === "OWNER" && target.is_active && (role !== "OWNER" || input.is_active === false)
  const dropsPassword = input.password === undefined && role === "CASHIER" && target.password_hash !== null
  // Cashiers can't sign in to the back office, so one who was demoted is signed out too
  const signOut = input.is_active === false || input.password !== undefined || dropsPassword || (role === "CASHIER" && roleChanged)
  const [passwordHash, pinHash] = await Promise.all([input.password ? hashPassword(input.password) : null, input.pin ? hashPin(input.pin) : null])

  let refused: UserConflict | null
  try {
    refused = await db.transaction(async (tx): Promise<UserConflict | null> => {
      if (input.email && (await emailTaken(tx, input.email, target.id))) return "DUPLICATE_EMAIL"
      if (removesOwner && !(await anotherActiveOwner(tx, actor.org_id, target.id))) return "LAST_OWNER"

      const set: Partial<typeof users.$inferInsert> = {}
      if (input.full_name !== undefined) set.full_name = input.full_name
      if (roleChanged) set.role = role
      if (input.email !== undefined) set.email = input.email
      if (input.password !== undefined) set.password_hash = passwordHash
      else if (dropsPassword) set.password_hash = null
      if (input.pin !== undefined) set.pin_hash = pinHash
      if (input.is_active !== undefined) set.is_active = input.is_active
      if (Object.keys(set).length > 0) await tx.update(users).set(set).where(eq(users.id, target.id))

      // Store access (the database bumps the user's version when these rows change)
      if (worksInEveryStore(role)) {
        if (roleChanged) await tx.delete(userStores).where(eq(userStores.user_id, target.id))
      } else if (storeIds && !sameStores(storeIds, target.store_ids)) {
        await tx.delete(userStores).where(eq(userStores.user_id, target.id))
        if (storeIds.length > 0) await tx.insert(userStores).values(storeIds.map((store_id) => ({ user_id: target.id, store_id })))
      }
      if (signOut) await destroyUserSessions(tx, target.id)
      return null
    })
  } catch (error) {
    if (isUniqueViolation(error, "users_email_idx")) return conflict("DUPLICATE_EMAIL")
    throw error
  }
  if (refused) return conflict(refused)
  const [user] = await orgUsers(db, actor.org_id, { userId: target.id })
  return NextResponse.json({ user: publicUser(actor, user) })
}

export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const actor = auth.user
  const db = getDb()
  const target = await userForActor(db, actor, (await params).id)
  if (!target) return notFound("User not found")
  const denial = deleteDenial(actor, target)
  if (denial) return denied(denial)

  const refused = await db.transaction(async (tx): Promise<UserConflict | null> => {
    if (target.role === "OWNER" && target.is_active && !(await anotherActiveOwner(tx, actor.org_id, target.id))) return "LAST_OWNER"
    // Soft delete, so it syncs down and the user drops off the tablets' sign-in screens
    await tx.update(users).set({ deleted_at: new Date(), is_active: false }).where(eq(users.id, target.id))
    await destroyUserSessions(tx, target.id)
    return null
  })
  if (refused) return conflict(refused)
  return NextResponse.json({ ok: true })
}
