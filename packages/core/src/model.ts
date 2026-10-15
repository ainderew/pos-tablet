// Records a terminal creates and syncs up. They are append-only: nothing is edited after it is
// written, so terminals never conflict. A void is a new credit-note record (the sale's VOIDED
// status is derived from it), and a shift is an open record plus a close record.
//
// Field names follow POS-bir's tables (snake_case) so the server schema and the PC app map 1:1.
// New compared with POS-bir: store_id, terminal_id, shift_id and cashier_id on sales,
// original_transaction_id on credit notes, product_name on items, and stock movements.
import { z } from "zod"

const id = z.string().min(1)
const money = z.number().finite()
const timestamp = z.iso.datetime() // ISO 8601 in UTC, e.g. 2026-10-15T03:59:18.390Z

export const PAYMENT_METHODS = ["CASH", "GCASH", "MAYA", "CARD", "STORE_CREDIT"] as const
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS)
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>

export const TaxCategorySchema = z.enum(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"])

/** Fields every terminal-created record has */
export const TerminalRecordSchema = z.object({
  id,
  store_id: id,
  terminal_id: id,
  created_at: timestamp,
})

/** A sale (SI-xxxxxx) or a credit note voiding one (CN-xxxxxx); numbers are per terminal */
export const TransactionRecordSchema = TerminalRecordSchema.extend({
  shift_id: id,
  cashier_id: id.nullable(),
  invoice_number: z.string().regex(/^(SI|CN)-\d{6,}$/),
  transaction_type: z.enum(["SALE", "VOID_REFUND"]),
  // Sales are recorded PAID and credit notes REFUND; VOIDED is derived when a credit note exists
  status: z.enum(["PAID", "REFUND"]),
  original_transaction_id: id.nullable(), // credit notes only
  void_reason: z.string().nullable(),
  authorized_by: id.nullable(), // manager who approved the void
  gross_sales: money,
  vatable_sales: money,
  vat_amount: money,
  vat_exempt_sales: money,
  zero_rated_sales: money,
  total_discount: money,
  net_sales: money, // negative on credit notes, like every amount above
  pax_count: z.number().int().min(1),
  senior_count: z.number().int().min(0),
  sc_pwd_id: z.string().nullable(),
  sc_pwd_name: z.string().nullable(),
  payment_method: PaymentMethodSchema,
  amount_tendered: money.nullable(),
  change_amount: money,
  // E-wallet/card reference; the customer id for STORE_CREDIT; the original invoice number on a credit note
  reference_number: z.string().nullable(),
})
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>

/** A sale line at the price actually charged (credit notes reference the sale instead of copying lines) */
export const TransactionItemRecordSchema = TerminalRecordSchema.extend({
  transaction_id: id,
  product_id: id,
  product_name: z.string(), // snapshot, so receipts and history survive a later rename
  quantity_sold: z.number().positive(),
  price_at_sale: money,
  cost_at_sale: money,
  tax_category: TaxCategorySchema,
})
export type TransactionItemRecord = z.infer<typeof TransactionItemRecordSchema>

/** Stock is the sum of movements, so terminals and back-office restocks never overwrite each other */
export const STOCK_MOVEMENT_REASONS = ["SALE", "VOID", "RESTOCK", "ADJUSTMENT"] as const
export const StockMovementRecordSchema = TerminalRecordSchema.extend({
  product_id: id,
  quantity_delta: z.number(), // negative = out of stock
  reason: z.enum(STOCK_MOVEMENT_REASONS),
  ref_id: id.nullable(), // the transaction for SALE / VOID
  note: z.string().nullable(),
})
export type StockMovementRecord = z.infer<typeof StockMovementRecordSchema>

/** Store credit ("utang"); a customer's balance is the sum of their entries */
export const CreditLedgerEntryRecordSchema = TerminalRecordSchema.extend({
  customer_id: id,
  transaction_id: id.nullable(),
  shift_id: id.nullable(),
  entry_type: z.enum(["CHARGE", "PAYMENT", "ADJUSTMENT"]),
  amount: money, // positive: CHARGE adds to the balance, PAYMENT and ADJUSTMENT deduct
  running_balance: money, // as known on this terminal when written; the server recomputes from the sum
  notes: z.string().nullable(),
})
export type CreditLedgerEntryRecord = z.infer<typeof CreditLedgerEntryRecordSchema>

/** Opening a shift; its id is the shift_id other records refer to */
export const ShiftOpenRecordSchema = TerminalRecordSchema.extend({
  user_id: id,
  opening_fund: money,
  snapshot_z_counter: z.number().int().min(0),
  snapshot_accumulated_total: money,
})
export type ShiftOpenRecord = z.infer<typeof ShiftOpenRecordSchema>

/** Closing a shift: expected (theoretical) vs counted (actual) amounts per payment method */
export const ShiftCloseRecordSchema = TerminalRecordSchema.extend({
  shift_id: id,
  user_id: id.nullable(),
  theoretical_cash: money,
  actual_cash: money,
  variance: money, // actual_cash - theoretical_cash
  theoretical_gcash: money,
  actual_gcash: money,
  theoretical_maya: money,
  actual_maya: money,
  theoretical_card: money,
  actual_card: money,
  snapshot_z_counter: z.number().int().min(0),
  snapshot_accumulated_total: money,
})
export type ShiftCloseRecord = z.infer<typeof ShiftCloseRecordSchema>

export const CashMovementRecordSchema = TerminalRecordSchema.extend({
  shift_id: id,
  user_id: id.nullable(),
  type: z.enum(["CASH_IN", "CASH_OUT", "SAFE_DROP"]),
  amount: money,
  reason: z.string().min(1),
})
export type CashMovementRecord = z.infer<typeof CashMovementRecordSchema>

/** End-of-day Z-reading for one terminal; the grand total only ever grows here */
export const ZReadingRecordSchema = TerminalRecordSchema.extend({
  user_id: id.nullable(),
  z_counter: z.number().int().min(1),
  sales_count: z.number().int().min(0),
  void_count: z.number().int().min(0),
  sales_total: money, // sales issued in the period (including ones voided later)
  void_total: money, // positive: credit notes issued in the period
  net_total: money, // sales_total - void_total
  total_vat: money,
  cash_sales_total: money,
  beginning_invoice: z.string().nullable(),
  ending_invoice: z.string().nullable(),
  beginning_credit_note: z.string().nullable(),
  ending_credit_note: z.string().nullable(),
  beginning_grand_total: money,
  accumulated_grand_total: money, // ending grand total
})
export type ZReadingRecord = z.infer<typeof ZReadingRecordSchema>
