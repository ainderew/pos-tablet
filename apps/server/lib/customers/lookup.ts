// Finding customers within the caller's scope: their organization, and a store they may work in
import { and, eq, isNull } from "drizzle-orm"
import { customers, stores } from "@pos/db"
import type { Db } from "@pos/db"
import type { AuthedUser } from "@/lib/auth/guard"
import { canAccessStore } from "@/lib/auth/guard"
import { isUuid } from "@/lib/stores"
import { customerBalance } from "./balance"

export type CustomerRow = typeof customers.$inferSelect
export type CustomerWithBalance = CustomerRow & { balance: number }

/** The (not deleted) customer with their balance, if their store is one the user may work in; else null */
export async function customerForUser(db: Db, user: AuthedUser, customerId: string): Promise<CustomerWithBalance | null> {
  if (!isUuid(customerId)) return null
  const [row] = await db
    .select({ customer: customers, balance: customerBalance(customers.id) })
    .from(customers)
    .innerJoin(stores, eq(stores.id, customers.store_id))
    .where(and(eq(customers.id, customerId), eq(stores.org_id, user.org_id), isNull(customers.deleted_at), isNull(stores.deleted_at)))
  if (!row || !canAccessStore(user, row.customer.store_id)) return null
  return { ...row.customer, balance: row.balance }
}

/** Re-reads a customer (already scope-checked) with their current balance */
export async function reloadCustomer(db: Db, customerId: string): Promise<CustomerWithBalance> {
  const [row] = await db.select({ customer: customers, balance: customerBalance(customers.id) }).from(customers).where(eq(customers.id, customerId))
  return { ...row.customer, balance: row.balance }
}

/** ILIKE pattern matching `text` anywhere, with the user's own % and _ taken literally */
export const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
