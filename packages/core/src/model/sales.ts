// Sales, credit notes and their effects (stock, store credit)
import { z } from "zod"
import { id, money, PaymentMethodSchema, TaxCategorySchema, TerminalRecordSchema, UnitTypeSchema } from "./common"

const nonNegative = money.min(0)
const nonPositive = money.max(0)

// Fields a sale and a credit note share; each schema below narrows them
const transactionFields = {
  shift_id: id,
  cashier_id: id.nullable(),
  pax_count: z.number().int().min(1),
  senior_count: z.number().int().min(0),
  sc_pwd_id: z.string().nullable(),
  sc_pwd_name: z.string().nullable(),
  payment_method: PaymentMethodSchema,
}

/** A sale, SI-xxxxxx (numbers are per terminal). It reads as VOIDED once a credit note references it. */
export const SaleRecordSchema = TerminalRecordSchema.extend({
  ...transactionFields,
  invoice_number: z.string().regex(/^SI-\d{6,}$/),
  transaction_type: z.literal("SALE"),
  status: z.literal("PAID"),
  original_transaction_id: z.null(),
  void_reason: z.null(),
  authorized_by: z.null(),
  gross_sales: nonNegative,
  vatable_sales: nonNegative,
  vat_amount: nonNegative,
  vat_exempt_sales: nonNegative,
  zero_rated_sales: nonNegative,
  total_discount: nonNegative,
  net_sales: nonNegative,
  amount_tendered: nonNegative.nullable(),
  change_amount: nonNegative,
  // E-wallet/card reference, or the customer id for STORE_CREDIT
  reference_number: z.string().nullable(),
})
export type SaleRecord = z.infer<typeof SaleRecordSchema>

/** A credit note, CN-xxxxxx: the voided sale with every amount negated */
export const CreditNoteRecordSchema = TerminalRecordSchema.extend({
  ...transactionFields,
  invoice_number: z.string().regex(/^CN-\d{6,}$/),
  transaction_type: z.literal("VOID_REFUND"),
  status: z.literal("REFUND"),
  original_transaction_id: id,
  void_reason: z.string().nullable(),
  authorized_by: id, // manager who approved the void
  gross_sales: nonPositive,
  vatable_sales: nonPositive,
  vat_amount: nonPositive,
  vat_exempt_sales: nonPositive,
  zero_rated_sales: nonPositive,
  total_discount: nonPositive,
  net_sales: nonPositive,
  amount_tendered: z.literal(0), // no tender or change on a void
  change_amount: z.literal(0),
  reference_number: z.string().regex(/^SI-\d{6,}$/), // the voided sale's invoice number
})
export type CreditNoteRecord = z.infer<typeof CreditNoteRecordSchema>

export const TransactionRecordSchema = z
  .discriminatedUnion("transaction_type", [SaleRecordSchema, CreditNoteRecordSchema])
  .superRefine((t, ctx) => {
    if (t.senior_count > t.pax_count) {
      ctx.addIssue({ code: "custom", path: ["senior_count"], message: "senior_count exceeds pax_count" })
    }
    if (t.senior_count > 0 && !t.sc_pwd_id) {
      ctx.addIssue({ code: "custom", path: ["sc_pwd_id"], message: "an SC/PWD discount needs the SC/PWD ID" })
    }
  })
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>

/** Whole thousandths: 3 decimal places at most (grams, for WEIGHT products) */
export const isThousandths = (q: number) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6

/** A sale line at the price actually charged (credit notes reference the sale instead of copying lines) */
export const TransactionItemRecordSchema = TerminalRecordSchema.extend({
  transaction_id: id,
  product_id: id,
  product_name: z.string(), // snapshot, so receipts and history survive a later rename
  unit_type: UnitTypeSchema,
  quantity_sold: z.number().positive(),
  price_at_sale: money,
  cost_at_sale: money,
  tax_category: TaxCategorySchema,
}).superRefine((item, ctx) => {
  const ok = item.unit_type === "QUANTITY" ? Number.isInteger(item.quantity_sold) : isThousandths(item.quantity_sold)
  if (!ok) ctx.addIssue({ code: "custom", path: ["quantity_sold"], message: `invalid quantity for a ${item.unit_type} product` })
})
export type TransactionItemRecord = z.infer<typeof TransactionItemRecordSchema>

/** Stock is the sum of movements, so terminals and back-office restocks never overwrite each other */
export const STOCK_MOVEMENT_REASONS = ["SALE", "VOID", "RESTOCK", "ADJUSTMENT"] as const
export const StockMovementRecordSchema = TerminalRecordSchema.extend({
  product_id: id,
  quantity_delta: z.number().refine((q) => q !== 0 && isThousandths(q), "a non-zero quantity in thousandths"),
  reason: z.enum(STOCK_MOVEMENT_REASONS),
  ref_id: id.nullable(), // the sale for SALE, the credit note for VOID
  note: z.string().nullable(),
})
export type StockMovementRecord = z.infer<typeof StockMovementRecordSchema>

/** Store credit ("utang"); a customer's balance is the sum of their entries */
export const CreditLedgerEntryRecordSchema = TerminalRecordSchema.extend({
  customer_id: id,
  transaction_id: id.nullable(),
  shift_id: id.nullable(),
  entry_type: z.enum(["CHARGE", "PAYMENT", "ADJUSTMENT"]),
  amount: money.min(0), // CHARGE adds to the balance, PAYMENT and ADJUSTMENT deduct
  running_balance: money, // as known on this terminal when written; the server recomputes from the sum
  notes: z.string().nullable(),
  // How a PAYMENT was made (null for CHARGE / ADJUSTMENT); POS-bir only kept this inside notes
  payment_method: PaymentMethodSchema.nullable(),
  reference_number: z.string().nullable(),
})
export type CreditLedgerEntryRecord = z.infer<typeof CreditLedgerEntryRecordSchema>
