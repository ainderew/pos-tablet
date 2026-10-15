// Loading an organization's users with their store assignments, and the shape the API returns
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { stores, userStores, users } from "@pos/db"
import type { Db } from "@pos/db"
import { isUuid } from "@/lib/stores"
import type { Actor } from "./permissions"
import { canSee, worksInEveryStore } from "./permissions"

export type UserWithStores = typeof users.$inferSelect & { store_ids: string[] }

/** The organization's users (by name), each with the live stores of the organization they're assigned to */
export async function orgUsers(db: Db, orgId: string, opts: { includeDeleted?: boolean; userId?: string } = {}): Promise<UserWithStores[]> {
  const where: SQL[] = [eq(users.org_id, orgId)]
  if (!opts.includeDeleted) where.push(isNull(users.deleted_at))
  if (opts.userId) where.push(eq(users.id, opts.userId))
  const rows = await db
    .select()
    .from(users)
    .where(and(...where))
    .orderBy(sql`lower(${users.full_name})`, asc(users.id))
  if (rows.length === 0) return []

  const links = await db
    .select({ user_id: userStores.user_id, store_id: userStores.store_id })
    .from(userStores)
    .innerJoin(stores, eq(stores.id, userStores.store_id))
    .where(and(inArray(userStores.user_id, rows.map((r) => r.id)), eq(stores.org_id, orgId), isNull(stores.deleted_at)))
    .orderBy(asc(userStores.store_id))
  const byUser = new Map<string, string[]>()
  for (const link of links) byUser.set(link.user_id, [...(byUser.get(link.user_id) ?? []), link.store_id])
  return rows.map((r) => ({ ...r, store_ids: byUser.get(r.id) ?? [] }))
}

/** The (not deleted) user, if the actor may see them; else null (404) */
export async function userForActor(db: Db, actor: Actor & { org_id: string }, userId: string): Promise<UserWithStores | null> {
  if (!isUuid(userId)) return null
  const [user] = await orgUsers(db, actor.org_id, { userId })
  return user && canSee(actor, user) ? user : null
}

/**
 * What the API returns for a user: never the password or PIN hash. store_ids is "ALL" for owners and
 * admins (as in /api/auth/me); a manager only sees the assignments to their own stores.
 */
export function publicUser(actor: Actor, user: UserWithStores) {
  const own = actor.storeIds
  return {
    id: user.id,
    org_id: user.org_id,
    full_name: user.full_name,
    role: user.role,
    email: user.email,
    is_active: user.is_active,
    has_password: user.password_hash !== null,
    has_pin: user.pin_hash !== null,
    store_ids: worksInEveryStore(user.role) ? ("ALL" as const) : own === "ALL" ? user.store_ids : user.store_ids.filter((id) => own.includes(id)),
    version: user.version,
    created_at: user.created_at,
    updated_at: user.updated_at,
    deleted_at: user.deleted_at,
  }
}

/**
 * The given store ids, deduplicated, if each is a live store of the organization the actor may work
 * in; otherwise null. Unknown and out-of-scope stores are refused alike, so ids can't be probed.
 */
export async function storesInScope(db: Db, actor: Actor & { org_id: string }, storeIds: string[]): Promise<string[] | null> {
  const wanted = [...new Set(storeIds)]
  if (wanted.length === 0) return []
  if (!wanted.every(isUuid)) return null
  const own = actor.storeIds
  if (own !== "ALL" && !wanted.every((id) => own.includes(id))) return null
  const found = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(inArray(stores.id, wanted), eq(stores.org_id, actor.org_id), isNull(stores.deleted_at)))
  return found.length === wanted.length ? wanted : null
}

/** The live stores a manager works in (the default for a cashier they create) */
export async function actorStores(db: Db, actor: Actor & { org_id: string }): Promise<string[]> {
  if (actor.storeIds === "ALL" || actor.storeIds.length === 0) return []
  const rows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(inArray(stores.id, actor.storeIds), eq(stores.org_id, actor.org_id), isNull(stores.deleted_at)))
    .orderBy(asc(stores.id))
  return rows.map((r) => r.id)
}
