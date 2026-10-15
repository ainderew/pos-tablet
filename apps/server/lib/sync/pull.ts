// Server-owned changes for one terminal (sync protocol v1): every row it may see whose version is
// above the cursor, oldest first, a page at a time. Versions commit in order (0002_ordered_versions),
// so a cursor never skips a change.
import { and, asc, eq, gt, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import type { PullResponse, PulledUser } from "@pos/core"
import { categories, creditLedger, customers, products, stockMovements, stores, terminals, users } from "@pos/db"
import type { Db } from "@pos/db"
import type { AuthedDevice } from "../auth/device"
import { storeForDevice } from "../stores"

export const DEFAULT_PULL_LIMIT = 500
export const MAX_PULL_LIMIT = 2000

type Change = { table: keyof PullResponse["changes"]; version: number; row: Record<string, unknown> }

export async function pullChanges(db: Db, device: AuthedDevice, cursor: number, limit: number): Promise<PullResponse> {
  // One snapshot for every read: versions commit in order, but separate connections (separate
  // snapshots) could see a later version in one table while missing an earlier one in another, and
  // the cursor would then skip it forever
  return db.transaction((tx) => readChanges(tx as unknown as Db, device, cursor, limit), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  })
}

async function readChanges(db: Db, device: AuthedDevice, cursor: number, limit: number): Promise<PullResponse> {
  const { terminal, store } = device
  const after = (version: AnyPgColumn) => gt(version, cursor)

  // Awaited one after another (inside the array literal, left to right): a transaction has one connection
  const [storeRows, terminalRows, categoryRows, productRows, customerRows, userRows] = [
    await db.select().from(stores).where(and(eq(stores.id, store.id), after(stores.version))).orderBy(asc(stores.version)).limit(limit),
    await db
      .select({
        id: terminals.id,
        store_id: terminals.store_id,
        name: terminals.name,
        kind: terminals.kind,
        ptu_number: terminals.ptu_number,
        serial_number: terminals.serial_number,
        min: terminals.min,
        revoked_at: terminals.revoked_at,
        version: terminals.version,
        deleted_at: terminals.deleted_at,
      })
      .from(terminals)
      .where(and(eq(terminals.id, terminal.id), after(terminals.version)))
      .orderBy(asc(terminals.version))
      .limit(limit),
    await db.select().from(categories).where(and(eq(categories.org_id, store.org_id), after(categories.version))).orderBy(asc(categories.version)).limit(limit),
    await db.select().from(products).where(and(eq(products.org_id, store.org_id), after(products.version))).orderBy(asc(products.version)).limit(limit),
    // Only what the counter needs for store credit (no email or address on the device)
    await db
      .select({
        id: customers.id,
        store_id: customers.store_id,
        full_name: customers.full_name,
        phone_number: customers.phone_number,
        credit_limit: customers.credit_limit,
        credit_status: customers.credit_status,
        version: customers.version,
        deleted_at: customers.deleted_at,
      })
      .from(customers)
      .where(and(eq(customers.store_id, store.id), after(customers.version)))
      .orderBy(asc(customers.version))
      .limit(limit),
    // PIN hashes so cashiers can sign in offline; never emails or password hashes
    await db
      .select({
        id: users.id,
        full_name: users.full_name,
        role: users.role,
        pin_hash: users.pin_hash,
        is_active: users.is_active,
        version: users.version,
        deleted_at: users.deleted_at,
        // Qualified by hand (single-table selects leave columns unqualified inside subqueries)
        has_access: sql<boolean>`("users"."role" in ('OWNER', 'ADMIN') or exists (select 1 from user_stores us where us.user_id = "users"."id" and us.store_id = ${store.id}))`,
      })
      .from(users)
      .where(and(eq(users.org_id, store.org_id), after(users.version)))
      .orderBy(asc(users.version))
      .limit(limit),
  ]

  const tagged: Change[] = [
    ...storeRows.map((s) => ({ table: "stores" as const, version: s.version, row: { ...storeForDevice(s), deleted_at: s.deleted_at } })),
    ...terminalRows.map((row) => ({ table: "terminals" as const, version: row.version, row })),
    ...categoryRows.map((row) => ({ table: "categories" as const, version: row.version, row })),
    ...productRows.map((row) => ({ table: "products" as const, version: row.version, row })),
    ...customerRows.map((row) => ({ table: "customers" as const, version: row.version, row })),
    ...userRows.map((row) => ({ table: "users" as const, version: row.version, row })),
  ].sort((a, b) => a.version - b.version)

  // Each table returned its oldest `limit` changes; taking the oldest `limit` of all of them never
  // leaves out a lower version from another table
  const taken = tagged.slice(0, limit)
  const fullTables = [storeRows, terminalRows, categoryRows, productRows, customerRows, userRows].some((rows) => rows.length === limit)
  const hasMore = tagged.length > limit || fullTables
  const changes: PullResponse["changes"] = { stores: [], terminals: [], categories: [], products: [], customers: [], users: [] }
  for (const c of taken) (changes[c.table] as Record<string, unknown>[]).push(c.row)
  changes.users = changes.users.map((row) => {
    const u = row as unknown as PulledUser
    const hasAccess = Boolean(u.has_access)
    // A PIN hash only goes to a device where that user can sign in: 4-6 digit PINs crack quickly
    // offline, so other stores' (and inactive or deleted users') hashes never leave the server
    const canSignInHere = hasAccess && u.is_active && !u.deleted_at
    return { ...u, has_access: hasAccess, pin_hash: canSignInHere ? u.pin_hash : null }
  })

  return {
    cursor: taken.length ? taken[taken.length - 1].version : cursor,
    has_more: hasMore,
    changes,
    stock: hasMore ? null : await storeStock(db, store.id),
    balances: hasMore ? null : await storeBalances(db, store.id),
    server_time: new Date().toISOString(),
  }
}

async function storeStock(db: Db, storeId: string) {
  const rows = await db
    .select({ product_id: stockMovements.product_id, stock_level: sql<string>`round(sum(${stockMovements.quantity_delta}), 3)` })
    .from(stockMovements)
    .where(eq(stockMovements.store_id, storeId))
    .groupBy(stockMovements.product_id)
  return rows.map((r) => ({ product_id: r.product_id, stock_level: Number(r.stock_level) }))
}

async function storeBalances(db: Db, storeId: string) {
  const rows = await db
    .select({
      customer_id: creditLedger.customer_id,
      balance: sql<string>`round(sum(case when ${creditLedger.entry_type} = 'CHARGE' then ${creditLedger.amount} else -${creditLedger.amount} end), 2)`,
    })
    .from(creditLedger)
    .where(eq(creditLedger.store_id, storeId))
    .groupBy(creditLedger.customer_id)
  return rows.map((r) => ({ customer_id: r.customer_id, balance: Number(r.balance) }))
}

