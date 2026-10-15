// Sales, credit notes and their effects (stock, store credit)
import { z } from "zod"
import { id, money, PaymentMethodSchema, TaxCategorySchema, TerminalRecordSchema } from "./common"

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
  // How a PAYMENT was made (null for CHARGE / ADJUSTMENT); POS-bir only kept this inside notes
  payment_method: PaymentMethodSchema.nullable(),
  reference_number: z.string().nullable(),
})
export type CreditLedgerEntryRecord = z.infer<typeof CreditLedgerEntryRecordSchema>

