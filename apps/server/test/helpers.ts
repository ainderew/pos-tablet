// Route handlers run directly against a fresh PGlite database per test file
import { organizations, stores, userStores, users } from "@pos/db"
import { createTestDb } from "@pos/db/testing"
import type { Db } from "@pos/db"
import { hashPassword } from "@/lib/auth/passwords"
import { setDb } from "@/lib/db"
import { resetRateLimits } from "@/lib/rate-limit"

export const PASSWORD = "correct horse battery"

export async function setupTestServer() {
  const t = await createTestDb()
  const db = t.db as unknown as Db
  setDb(db)
  resetRateLimits()
  const [org] = await db.insert(organizations).values({ name: "General Store" }).returning()
  const [otherOrg] = await db.insert(organizations).values({ name: "Another Business" }).returning()
  const [store] = await db.insert(stores).values({ org_id: org.id, name: "Main" }).returning()
  const [branch] = await db.insert(stores).values({ org_id: org.id, name: "Branch" }).returning()
  const [foreignStore] = await db.insert(stores).values({ org_id: otherOrg.id, name: "Not ours" }).returning()
  const passwordHash = await hashPassword(PASSWORD)
  const mk = async (full_name: string, role: "OWNER" | "MANAGER" | "CASHIER", email: string | null) => {
    const [u] = await db.insert(users).values({ org_id: org.id, full_name, role, email, password_hash: email ? passwordHash : null }).returning()
    return u
  }
  const owner = await mk("Olivia Owner", "OWNER", "owner@example.com")
  const manager = await mk("Manny Manager", "MANAGER", "manager@example.com")
  const cashier = await mk("Cara Cashier", "CASHIER", "cashier@example.com")
  await db.insert(userStores).values({ user_id: manager.id, store_id: store.id })
  return {
    db,
    ids: { org: org.id, store: store.id, branch: branch.id, foreignStore: foreignStore.id, owner: owner.id, manager: manager.id, cashier: cashier.id },
    close: async () => {
      setDb(null)
      await t.close()
    },
  }
}

type Init = { body?: unknown; cookie?: string | null; origin?: string | null; headers?: Record<string, string> }

/** A request as the browser would send it to the back office at http://localhost */
export function req(method: string, path: string, init: Init = {}) {
  const headers: Record<string, string> = { host: "localhost", ...(init.headers ?? {}) }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  if (init.cookie) headers.cookie = init.cookie
  const origin = init.origin === undefined ? "http://localhost" : init.origin
  if (origin && method !== "GET") headers.origin = origin
  return new Request(`http://localhost${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
}

/** "pos_session=..." from a response's Set-Cookie, ready to send back */
export function sessionFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  const match = /pos_session=([^;]*)/.exec(header)
  if (!match?.[1]) throw new Error(`no session cookie in: ${header}`)
  return `pos_session=${match[1]}`
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
