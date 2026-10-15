// Records a terminal creates and syncs up. They are append-only: nothing is edited after it is
// written, so terminals never conflict. A void is a new credit-note record (the sale's VOIDED
// status is derived from it), and a shift is an open record plus a close record.
//
// Field names follow POS-bir's tables (snake_case) so the server schema and the PC app map 1:1.
// New compared with POS-bir: store_id, terminal_id, shift_id and cashier_id on sales,
// original_transaction_id on credit notes, product_name on items, and stock movements.
import { z } from "zod"

export const id = z.string().min(1)
export const money = z.number().finite()
export const timestamp = z.iso.datetime() // ISO 8601 in UTC, e.g. 2026-10-15T03:59:18.390Z

export const PAYMENT_METHODS = ["CASH", "GCASH", "MAYA", "CARD", "STORE_CREDIT"] as const
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS)
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>

export const TaxCategorySchema = z.enum(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"])
export const UnitTypeSchema = z.enum(["QUANTITY", "WEIGHT"])

/** Fields every terminal-created record has */
export const TerminalRecordSchema = z.object({
  id,
  store_id: id,
  terminal_id: id,
  // Creation order on the terminal (1, 2, 3, ...), independent of the device clock: sync acks by it,
  // and a Z-reading covers exactly the records created since the previous Z by this order
  device_seq: z.number().int().positive(),
  created_at: timestamp, // device clock; printed on receipts, never used to decide what a Z covers
})

