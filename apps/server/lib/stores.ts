import { and, eq, isNull, max, sql } from "drizzle-orm"
import { auditLogs, cashMovements, creditLedger, shiftCloses, shiftOpens, stockMovements, stores, terminals, transactionItems, transactions, zReadings } from "@pos/db"
import type { Db } from "@pos/db"
import type { AuthedUser } from "./auth/guard"
import { canAccessStore } from "./auth/guard"

/** The store, if it exists in the user's organization and the user may work in it */
export async function storeForUser(db: Db, user: AuthedUser, storeId: string) {
  if (!isUuid(storeId)) return null
  const [store] = await db
    .select()
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.org_id, user.org_id), isNull(stores.deleted_at)))
  return store && canAccessStore(user, store.id) ? store : null
}

/** The terminal, if its store is one the user may work in */
export async function terminalForUser(db: Db, user: AuthedUser, terminalId: string) {
  if (!isUuid(terminalId)) return null
  const [row] = await db
    .select({ terminal: terminals, store: stores })
    .from(terminals)
    .innerJoin(stores, eq(stores.id, terminals.store_id))
    .where(and(eq(terminals.id, terminalId), eq(stores.org_id, user.org_id), isNull(terminals.deleted_at)))
  return row && canAccessStore(user, row.store.id) ? row : null
}

/** What a device needs to know about its store (receipts and offline policies) */
export function storeForDevice(store: typeof stores.$inferSelect) {
  return {
    id: store.id,
    name: store.name,
    business_name: store.business_name,
    business_address: store.business_address,
    business_tin: store.business_tin,
    receipt_header_lines: store.receipt_header_lines,
    receipt_footer_lines: store.receipt_footer_lines,
    time_zone: store.time_zone,
    stock_policy: store.stock_policy,
    offline_credit_mode: store.offline_credit_mode,
    offline_credit_cap: store.offline_credit_cap,
    version: store.version,
  }
}

/**
 * Where a terminal's numbering left off on the server: a device paired to an existing terminal must
 * continue after these, or its records would collide with ones already synced
 */
/** Highest device_seq the server holds from this terminal, across every record table */
export async function terminalHighestSeq(db: Db, terminalId: string): Promise<number> {
  const seqTables = [shiftOpens, shiftCloses, transactions, transactionItems, stockMovements, creditLedger, cashMovements, zReadings, auditLogs]
  let highest = 0
  for (const table of seqTables) {
    const [row] = await db.select({ seq: max(table.device_seq) }).from(table).where(eq(table.terminal_id, terminalId))
    highest = Math.max(highest, Number(row?.seq ?? 0))
  }
  return highest
}

export async function terminalResumePoint(db: Db, terminalId: string) {
  const lastDeviceSeq = await terminalHighestSeq(db, terminalId)
  const lastNumber = async (prefix: "SI" | "CN") => {
    const [row] = await db
      .select({ n: sql<string>`coalesce(max(substring(${transactions.invoice_number} from 4)::bigint), 0)` })
      .from(transactions)
      .where(and(eq(transactions.terminal_id, terminalId), sql`${transactions.invoice_number} like ${prefix + "-%"}`))
    return Number(row?.n ?? 0)
  }
  const [lastZ] = await db
    .select({ z_counter: zReadings.z_counter, device_seq: zReadings.device_seq, accumulated_grand_total: zReadings.accumulated_grand_total, created_at: zReadings.created_at })
    .from(zReadings)
    .where(eq(zReadings.terminal_id, terminalId))
    .orderBy(sql`${zReadings.z_counter} desc`)
    .limit(1)
  return {
    last_device_seq: lastDeviceSeq,
    last_invoice_number: await lastNumber("SI"),
    last_credit_note_number: await lastNumber("CN"),
    last_z_reading: lastZ ?? null,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: string) => UUID.test(value)
