// Checks that need the database, run inside the write's transaction
import { and, eq, isNull, ne, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { users } from "@pos/db"
import type { Db } from "@pos/db"

/**
 * Whether another (not deleted) user already has this email, in any organization: sign-in is by email
 * alone, and the database's unique index covers deactivated users too
 */
export async function emailTaken(db: Db, email: string, exceptUserId?: string): Promise<boolean> {
  const where: SQL[] = [sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deleted_at)]
  if (exceptUserId) where.push(ne(users.id, exceptUserId))
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(...where))
    .limit(1)
  return !!row
}

/**
 * Locks the organization's active owners and says whether one other than `userId` remains. The lock
 * makes two owners demoting each other at once take turns, so the second one sees it would be the last.
 */
export async function anotherActiveOwner(db: Db, orgId: string, userId: string): Promise<boolean> {
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.org_id, orgId), eq(users.role, "OWNER"), eq(users.is_active, true), isNull(users.deleted_at)))
    .for("update")
  return owners.some((o) => o.id !== userId)
}

/** A unique-index violation (Postgres 23505) on `constraint`, also when wrapped by Drizzle */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, constraint: name } = e as { code?: unknown; constraint?: unknown }
    if (code === "23505" && name === constraint) return true
  }
  return false
}
