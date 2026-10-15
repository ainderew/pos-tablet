// Sync protocol v1, shared by terminals and the server (docs/architecture.md, "Sync protocol").
// Push: a terminal sends its records in device_seq order; resends are harmless. Pull: the terminal
// asks for every server-owned row changed after a cursor (the global change version).
import { z } from "zod"
import {
  AuditLogRecordSchema,
  CashMovementRecordSchema,
  CreditLedgerEntryRecordSchema,
  ShiftCloseRecordSchema,
  ShiftOpenRecordSchema,
  StockMovementRecordSchema,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
  ZReadingRecordSchema,
} from "./model"

export const SYNC_PROTOCOL_VERSION = 1
export const MAX_PUSH_RECORDS = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_INT32 = 2_147_483_647
// Columns that hold whole numbers or weights; every other number in a record is money
const INTEGER_FIELDS = new Set(["device_seq", "pax_count", "senior_count", "z_counter", "sales_count", "void_count", "snapshot_z_counter"])
const QUANTITY_FIELDS = new Set(["quantity_sold", "quantity_delta"])
const MAX_MONEY = 999_999_999_999.99 // numeric(14,2)
const MAX_TEXT = 2000
const MAX_METADATA = 8000
const isCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
const isThousandths = (n: number) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6

/**
 * What the server's columns can store exactly, checked before anything is written: ids are UUIDs,
 * counters fit 32 bits, money is whole centavos, quantities whole grams, text and metadata are
 * bounded. (The record schemas describe meaning; these are storage limits.)
 */
function checkStorable(data: Record<string, unknown>, ctx: z.RefinementCtx) {
  for (const [key, value] of Object.entries(data)) {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["data", key], message })
    if (typeof value === "string") {
      // sc_pwd_id is a senior citizen / PWD ID card number, not a record id
      const isRecordId = (key === "id" || key.endsWith("_id") || key === "authorized_by") && key !== "sc_pwd_id"
      if (isRecordId && !UUID.test(value)) issue("must be a UUID")
      else if (value.length > MAX_TEXT) issue(`must be at most ${MAX_TEXT} characters`)
    } else if (typeof value === "number") {
      if (INTEGER_FIELDS.has(key)) {
        if (!Number.isInteger(value) || value < 0 || value > MAX_INT32) issue("must be a whole number that fits 32 bits")
      } else if (QUANTITY_FIELDS.has(key)) {
        if (!isThousandths(value) || Math.abs(value) >= 1e11) issue("must be in grams (3 decimals) and in range")
      } else if (!isCents(value) || Math.abs(value) > MAX_MONEY) {
        issue("must be in centavos (2 decimals) and in range")
      }
    } else if (key === "metadata" && JSON.stringify(value).length > MAX_METADATA) {
      issue(`must be at most ${MAX_METADATA} characters as JSON`)
    }
  }
}

export const PushRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shift_open"), data: ShiftOpenRecordSchema }),
  z.object({ type: z.literal("shift_close"), data: ShiftCloseRecordSchema }),
  z.object({ type: z.literal("transaction"), data: TransactionRecordSchema }),
  z.object({ type: z.literal("transaction_item"), data: TransactionItemRecordSchema }),
  z.object({ type: z.literal("stock_movement"), data: StockMovementRecordSchema }),
  z.object({ type: z.literal("credit_ledger_entry"), data: CreditLedgerEntryRecordSchema }),
  z.object({ type: z.literal("cash_movement"), data: CashMovementRecordSchema }),
  z.object({ type: z.literal("z_reading"), data: ZReadingRecordSchema }),
  z.object({ type: z.literal("audit_log"), data: AuditLogRecordSchema }),
]).superRefine((record, ctx) => checkStorable(record.data as Record<string, unknown>, ctx))
export type PushRecord = z.infer<typeof PushRecordSchema>
export type PushRecordType = PushRecord["type"]

export const PushRequestSchema = z.object({
  protocol: z.literal(SYNC_PROTOCOL_VERSION),
  records: z
    .array(PushRecordSchema)
    .min(1)
    .max(MAX_PUSH_RECORDS)
    .refine(
      (records) => records.every((r, i) => i === 0 || r.data.device_seq > records[i - 1].data.device_seq),
      "records must be in strictly increasing device_seq order"
    ),
})
export type PushRequest = z.infer<typeof PushRequestSchema>

export interface PushResponse {
  /** device_seqs stored by this request */
  accepted: number[]
  /** device_seqs the server already had (a resend): also safe to mark as synced */
  duplicates: number[]
  /** Highest device_seq the server holds for this terminal */
  highest_seq: number
}

/** A user as a terminal sees them: enough to sign in offline with a PIN, never a password */
export interface PulledUser {
  id: string
  full_name: string
  role: "OWNER" | "ADMIN" | "MANAGER" | "CASHIER"
  pin_hash: string | null
  is_active: boolean
  /** False once the user may no longer work in this store: treat like deleted */
  has_access: boolean
  version: number
  deleted_at: string | null
}

export interface PullResponse {
  /** Pass back as ?cursor= next time */
  cursor: number
  /** More changes are waiting: pull again right away */
  has_more: boolean
  changes: {
    stores: Record<string, unknown>[]
    terminals: Record<string, unknown>[]
    categories: Record<string, unknown>[]
    products: Record<string, unknown>[]
    customers: Record<string, unknown>[]
    users: PulledUser[]
  }
  /**
   * Current server totals for this store, on the last page only: the terminal adds its own unsynced
   * movements / ledger entries on top
   */
  stock: { product_id: string; stock_level: number }[] | null
  balances: { customer_id: string; balance: number }[] | null
  server_time: string
}
