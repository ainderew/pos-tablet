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
])
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
