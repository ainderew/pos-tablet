// The one way back-office route handlers authenticate: requireUser(request, { roles }) and
// canAccessStore(user, storeId). Writes also need a same-origin request (CSRF protection).
import { eq } from "drizzle-orm"
import { userStores } from "@pos/db"
import type { UserRole } from "@pos/db"
import { getDb } from "../db"
import { errorResponse, forbidden, unauthorized } from "../http"
import { loadSession, readCookie, SESSION_COOKIE } from "./session"
import type { SessionUser } from "./session"

export interface AuthedUser extends SessionUser {
  /** Stores this user may work in; owners and admins: every store in their organization */
  storeIds: string[] | "ALL"
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * A state-changing request must come from this site: its Origin must match the host it was sent to
 * (nginx forwards the original Host). The session cookie is SameSite=Lax as a second layer.
 */
export function isSameOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) return true
  const origin = request.headers.get("origin")
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export async function requireUser(
  request: Request,
  opts: { roles?: readonly UserRole[] } = {}
): Promise<{ ok: true; user: AuthedUser } | { ok: false; response: Response }> {
  if (!isSameOrigin(request)) {
    return { ok: false, response: errorResponse(403, "CROSS_SITE", "Cross-site request refused") }
  }
  const db = getDb()
  const user = await loadSession(db, readCookie(request, SESSION_COOKIE))
  if (!user) return { ok: false, response: unauthorized() }
  if (opts.roles && !opts.roles.includes(user.role)) return { ok: false, response: forbidden() }

  let storeIds: AuthedUser["storeIds"] = "ALL"
  if (user.role !== "OWNER" && user.role !== "ADMIN") {
    const rows = await db.select({ store_id: userStores.store_id }).from(userStores).where(eq(userStores.user_id, user.id))
    storeIds = rows.map((r) => r.store_id)
  }
  return { ok: true, user: { ...user, storeIds } }
}

/** Owners/admins: any store of their organization (the caller must still check the store's org_id) */
export function canAccessStore(user: AuthedUser, storeId: string): boolean {
  return user.storeIds === "ALL" || user.storeIds.includes(storeId)
}

/** Roles allowed to manage the catalog, customers, users and terminals */
export const MANAGERS: readonly UserRole[] = ["OWNER", "ADMIN", "MANAGER"]
