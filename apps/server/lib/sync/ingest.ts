// Stores a terminal's pushed records (sync protocol v1). Everything in a batch must belong to the
// pushing terminal, and everything it references must belong to that terminal, its store or its
// organization. The batch is stored in one transaction, in device_seq order; a resend is reported as
// duplicates, and a record that clashes with a different one already stored rejects the whole batch.
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import type { PushRecord, PushResponse } from "@pos/core"
import {
  auditLogs,
  cashMovements,
  creditLedger,
  customers,
  products,
  shiftCloses,
  shiftOpens,
  stockMovements,
  transactionItems,
  transactions,
  users,
  zReadings,
} from "@pos/db"
import type { Db } from "@pos/db"
import type { AuthedDevice } from "../auth/device"
import { terminalHighestSeq } from "../stores"

const TABLES = {
  shift_open: shiftOpens,
  shift_close: shiftCloses,
  transaction: transactions,
  transaction_item: transactionItems,
  stock_movement: stockMovements,
  credit_ledger_entry: creditLedger,
  cash_movement: cashMovements,
  z_reading: zReadings,
  audit_log: auditLogs,
} as const

export class SyncRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly deviceSeq?: number
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export async function ingestPush(db: Db, device: AuthedDevice, records: PushRecord[]): Promise<PushResponse> {
  const { terminal, store } = device
  for (const r of records) {
    if (r.data.terminal_id !== terminal.id || r.data.store_id !== store.id) {
      throw new SyncRejection(400, "WRONG_TERMINAL", "A record belongs to another terminal or store", r.data.device_seq)
    }
  }

  return db.transaction(async (tx) => {
    await checkReferences(tx, device, records)

    const accepted: number[] = []
    const duplicates: number[] = []
    for (const r of records) {
      const table = TABLES[r.type]
      const row = { ...r.data, created_at: new Date(r.data.created_at) }
      // Drizzle can't type an insert into "one of nine tables"; each row matches its table (same field names)
      const inserted = await tx.insert(table as typeof transactions).values(row as never).onConflictDoNothing().returning({ id: table.id })
      if (inserted.length) {
        accepted.push(r.data.device_seq)
        await applyServerRules(tx, r)
        continue
      }
      const [existing] = await tx
        .select({ terminal_id: table.terminal_id, device_seq: table.device_seq })
        .from(table as typeof transactions)
        .where(eq(table.id, r.data.id))
      if (existing?.terminal_id === terminal.id && existing.device_seq === r.data.device_seq) {
        duplicates.push(r.data.device_seq)
        continue
      }
      throw new SyncRejection(409, "SYNC_CONFLICT", `Record ${r.data.device_seq} clashes with one the server already has`, r.data.device_seq)
    }
    return { accepted, duplicates, highest_seq: await terminalHighestSeq(tx as unknown as Db, terminal.id) }
  })
}

/** Every id a record points at must be this terminal's (shifts, sales), this store's (customers) or this organization's (products, users) */
async function checkReferences(tx: Tx, device: AuthedDevice, records: PushRecord[]) {
  const { terminal, store } = device
  const inBatch = (type: PushRecord["type"]) => new Set(records.filter((r) => r.type === type).map((r) => r.data.id))
  const batchShifts = inBatch("shift_open")
  const batchTransactions = inBatch("transaction")

  const shiftRefs = new Map<string, number>()
  const transactionRefs = new Map<string, number>()
  const productRefs = new Map<string, number>()
  const customerRefs = new Map<string, number>()
  const userRefs = new Map<string, number>()
  const ref = (map: Map<string, number>, id: string | null | undefined, seq: number) => {
    if (id && !map.has(id)) map.set(id, seq)
  }
  for (const r of records) {
    const seq = r.data.device_seq
    switch (r.type) {
      case "shift_open":
        ref(userRefs, r.data.user_id, seq)
        break
      case "shift_close":
        ref(shiftRefs, r.data.shift_id, seq)
        ref(userRefs, r.data.user_id, seq)
        break
      case "transaction":
        ref(shiftRefs, r.data.shift_id, seq)
        ref(userRefs, r.data.cashier_id, seq)
        ref(userRefs, r.data.authorized_by, seq)
        ref(transactionRefs, r.data.original_transaction_id, seq)
        if (r.data.payment_method === "STORE_CREDIT" && r.data.transaction_type === "SALE") ref(customerRefs, r.data.reference_number, seq)
        break
      case "transaction_item":
        ref(transactionRefs, r.data.transaction_id, seq)
        ref(productRefs, r.data.product_id, seq)
        break
      case "stock_movement":
        ref(productRefs, r.data.product_id, seq)
        break
      case "credit_ledger_entry":
        ref(customerRefs, r.data.customer_id, seq)
        ref(transactionRefs, r.data.transaction_id, seq)
        ref(shiftRefs, r.data.shift_id, seq)
        break
      case "cash_movement":
        ref(shiftRefs, r.data.shift_id, seq)
        ref(userRefs, r.data.user_id, seq)
        break
      case "z_reading":
        ref(userRefs, r.data.user_id, seq)
        break
      case "audit_log":
        ref(shiftRefs, r.data.shift_id, seq)
        ref(userRefs, r.data.user_id, seq)
        break
    }
  }

  const missing = async (map: Map<string, number>, batch: Set<string>, found: (ids: string[]) => Promise<string[]>, what: string) => {
    const ids = [...map.keys()].filter((id) => !batch.has(id))
    if (!ids.length) return
    const ok = new Set(await found(ids))
    const bad = ids.find((id) => !ok.has(id))
    if (bad) throw new SyncRejection(400, "UNKNOWN_REFERENCE", `${what} ${bad} is not this terminal's or doesn't exist`, map.get(bad))
  }
  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id)
  await missing(shiftRefs, batchShifts, async (list) => ids(await tx.select({ id: shiftOpens.id }).from(shiftOpens).where(and(inArray(shiftOpens.id, list), eq(shiftOpens.terminal_id, terminal.id)))), "Shift")
  await missing(transactionRefs, batchTransactions, async (list) => ids(await tx.select({ id: transactions.id }).from(transactions).where(and(inArray(transactions.id, list), eq(transactions.terminal_id, terminal.id)))), "Transaction")
  await missing(productRefs, new Set(), async (list) => ids(await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, list), eq(products.org_id, store.org_id)))), "Product")
  await missing(customerRefs, new Set(), async (list) => ids(await tx.select({ id: customers.id }).from(customers).where(and(inArray(customers.id, list), eq(customers.store_id, store.id)))), "Customer")
  await missing(userRefs, new Set(), async (list) => ids(await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, list), eq(users.org_id, store.org_id)))), "User")
}

/** Server-side consequences of a stored record */
async function applyServerRules(tx: Tx, r: PushRecord) {
  // POS-bir's rule: a payment that brings a BLOCKED customer back within their limit unblocks them
  if (r.type === "credit_ledger_entry" && r.data.entry_type === "PAYMENT") {
    const balance = sql<number>`coalesce((select sum(case when cl.entry_type = 'CHARGE' then cl.amount else -cl.amount end) from credit_ledger cl where cl.customer_id = "customers"."id"), 0)`
    await tx
      .update(customers)
      .set({ credit_status: "ACTIVE" })
      .where(and(eq(customers.id, r.data.customer_id), eq(customers.credit_status, "BLOCKED"), sql`${balance} <= ${customers.credit_limit}`, isNull(customers.deleted_at)))
  }
}

