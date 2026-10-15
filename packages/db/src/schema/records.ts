// Records terminals create and push (append-only, mirrors @pos/core's model). Every terminal-created
// row is unique by (terminal_id, device_seq), so a resent batch inserts nothing twice. Stock movements
// and ledger entries can also come from the back office: those have no terminal and say who made them.
import { sql } from "drizzle-orm"
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { money, quantity, terminalRecordColumns, timestamptz } from "./columns"
import { customers, products } from "./catalog"
import { users } from "./people"
import { stores, terminals } from "./tenancy"

const owner = () => ({
  store_id: uuid()
    .notNull()
    .references(() => stores.id),
  terminal_id: uuid()
    .notNull()
    .references(() => terminals.id),
})

export const shiftOpens = pgTable(
  "shift_opens",
  {
    ...terminalRecordColumns(),
    ...owner(),
    user_id: uuid()
      .notNull()
      .references(() => users.id),
    opening_fund: money().notNull(),
    snapshot_z_counter: integer().notNull(),
    snapshot_accumulated_total: money().notNull(),
  },
  (t) => [uniqueIndex("shift_opens_seq_idx").on(t.terminal_id, t.device_seq)]
)

export const shiftCloses = pgTable(
  "shift_closes",
  {
    ...terminalRecordColumns(),
    ...owner(),
    shift_id: uuid()
      .notNull()
      .references(() => shiftOpens.id),
    user_id: uuid().references(() => users.id),
    theoretical_cash: money().notNull(),
    actual_cash: money().notNull(),
    cash_variance: money().notNull(),
    theoretical_gcash: money().notNull(),
    actual_gcash: money().notNull(),
    gcash_variance: money().notNull(),
    theoretical_maya: money().notNull(),
    actual_maya: money().notNull(),
    maya_variance: money().notNull(),
    theoretical_card: money().notNull(),
    actual_card: money().notNull(),
    card_variance: money().notNull(),
    variance: money().notNull(),
    snapshot_z_counter: integer().notNull(),
    snapshot_accumulated_total: money().notNull(),
  },
  (t) => [uniqueIndex("shift_closes_seq_idx").on(t.terminal_id, t.device_seq), uniqueIndex("shift_closes_shift_idx").on(t.shift_id)]
)

/** Sales (SI-) and credit notes (CN-); a sale reads as VOIDED when a credit note references it */
export const transactions = pgTable(
  "transactions",
  {
    ...terminalRecordColumns(),
    ...owner(),
    shift_id: uuid()
      .notNull()
      .references(() => shiftOpens.id),
    cashier_id: uuid().references(() => users.id),
    invoice_number: text().notNull(),
    transaction_type: text().notNull(),
    status: text().notNull(),
    original_transaction_id: uuid(),
    void_reason: text(),
    authorized_by: uuid().references(() => users.id),
    gross_sales: money().notNull(),
    vatable_sales: money().notNull(),
    vat_amount: money().notNull(),
    vat_exempt_sales: money().notNull(),
    zero_rated_sales: money().notNull(),
    total_discount: money().notNull(),
    net_sales: money().notNull(),
    pax_count: integer().notNull(),
    senior_count: integer().notNull(),
    sc_pwd_id: text(),
    sc_pwd_name: text(),
    payment_method: text().notNull(),
    amount_tendered: money(),
    change_amount: money().notNull(),
    reference_number: text(),
  },
  (t) => [
    uniqueIndex("transactions_seq_idx").on(t.terminal_id, t.device_seq),
    uniqueIndex("transactions_number_idx").on(t.terminal_id, t.invoice_number),
    // One credit note per sale
    uniqueIndex("transactions_voids_idx").on(t.original_transaction_id).where(sql`${t.original_transaction_id} is not null`),
    index("transactions_store_time_idx").on(t.store_id, t.created_at),
    index("transactions_shift_idx").on(t.shift_id),
    check("transactions_type_check", sql`${t.transaction_type} in ('SALE', 'VOID_REFUND')`),
    check("transactions_status_check", sql`${t.status} in ('PAID', 'REFUND')`),
    check(
      "transactions_payment_method_check",
      sql`${t.payment_method} in ('CASH', 'GCASH', 'MAYA', 'CARD', 'STORE_CREDIT')`
    ),
  ]
)

export const transactionItems = pgTable(
  "transaction_items",
  {
    ...terminalRecordColumns(),
    ...owner(),
    transaction_id: uuid()
      .notNull()
      .references(() => transactions.id),
    product_id: uuid()
      .notNull()
      .references(() => products.id),
    product_name: text().notNull(),
    unit_type: text().notNull(),
    quantity_sold: quantity().notNull(),
    price_at_sale: money().notNull(),
    cost_at_sale: money().notNull(),
    tax_category: text().notNull(),
  },
  (t) => [uniqueIndex("transaction_items_seq_idx").on(t.terminal_id, t.device_seq), index("transaction_items_tx_idx").on(t.transaction_id)]
)

/** Stock per store is the sum of these. From a terminal (sales, voids, restocks) or the back office. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid().primaryKey(),
    store_id: uuid()
      .notNull()
      .references(() => stores.id),
    terminal_id: uuid().references(() => terminals.id),
    device_seq: integer(),
    created_by: uuid().references(() => users.id), // back-office movements
    created_at: timestamptz().notNull(),
    received_at: timestamptz().notNull().defaultNow(),
    product_id: uuid()
      .notNull()
      .references(() => products.id),
    quantity_delta: quantity().notNull(),
    reason: text().notNull(),
    ref_id: uuid(),
    note: text(),
  },
  (t) => [
    uniqueIndex("stock_movements_seq_idx").on(t.terminal_id, t.device_seq).where(sql`${t.terminal_id} is not null`),
    index("stock_movements_product_idx").on(t.store_id, t.product_id),
    check("stock_movements_reason_check", sql`${t.reason} in ('SALE', 'VOID', 'RESTOCK', 'ADJUSTMENT')`),
    check("stock_movements_origin_check", sql`(${t.terminal_id} is null) = (${t.device_seq} is null)`),
  ]
)

/** Store credit; a customer's balance is the sum of entries (CHARGE adds, PAYMENT/ADJUSTMENT deduct) */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid().primaryKey(),
    store_id: uuid()
      .notNull()
      .references(() => stores.id),
    terminal_id: uuid().references(() => terminals.id),
    device_seq: integer(),
    created_by: uuid().references(() => users.id), // back-office entries
    created_at: timestamptz().notNull(),
    received_at: timestamptz().notNull().defaultNow(),
    customer_id: uuid()
      .notNull()
      .references(() => customers.id),
    transaction_id: uuid().references(() => transactions.id),
    shift_id: uuid().references(() => shiftOpens.id),
    entry_type: text().notNull(),
    amount: money().notNull(),
    running_balance: money().notNull(), // as known where it was written; the balance is the sum
    notes: text(),
    payment_method: text(),
    reference_number: text(),
  },
  (t) => [
    uniqueIndex("credit_ledger_seq_idx").on(t.terminal_id, t.device_seq).where(sql`${t.terminal_id} is not null`),
    index("credit_ledger_customer_idx").on(t.customer_id, t.created_at),
    check("credit_ledger_entry_type_check", sql`${t.entry_type} in ('CHARGE', 'PAYMENT', 'ADJUSTMENT')`),
    check("credit_ledger_amount_check", sql`${t.amount} >= 0`),
    check("credit_ledger_origin_check", sql`(${t.terminal_id} is null) = (${t.device_seq} is null)`),
  ]
)

export const cashMovements = pgTable(
  "cash_movements",
  {
    ...terminalRecordColumns(),
    ...owner(),
    shift_id: uuid()
      .notNull()
      .references(() => shiftOpens.id),
    user_id: uuid().references(() => users.id),
    type: text().notNull(),
    amount: money().notNull(),
    reason: text().notNull(),
  },
  (t) => [
    uniqueIndex("cash_movements_seq_idx").on(t.terminal_id, t.device_seq),
    check("cash_movements_type_check", sql`${t.type} in ('CASH_IN', 'CASH_OUT', 'SAFE_DROP')`),
    check("cash_movements_amount_check", sql`${t.amount} > 0`),
  ]
)

export const zReadings = pgTable(
  "z_readings",
  {
    ...terminalRecordColumns(),
    ...owner(),
    user_id: uuid().references(() => users.id),
    z_counter: integer().notNull(),
    sales_count: integer().notNull(),
    void_count: integer().notNull(),
    sales_total: money().notNull(),
    void_total: money().notNull(),
    net_total: money().notNull(),
    total_vat: money().notNull(),
    cash_sales_total: money().notNull(),
    opening_funds_total: money().notNull(),
    cash_in_total: money().notNull(),
    cash_out_total: money().notNull(),
    safe_drop_total: money().notNull(),
    theoretical_cash: money().notNull(),
    beginning_invoice: text(),
    ending_invoice: text(),
    beginning_credit_note: text(),
    ending_credit_note: text(),
    beginning_grand_total: money().notNull(),
    accumulated_grand_total: money().notNull(),
  },
  (t) => [uniqueIndex("z_readings_seq_idx").on(t.terminal_id, t.device_seq), uniqueIndex("z_readings_counter_idx").on(t.terminal_id, t.z_counter)]
)

export const auditLogs = pgTable(
  "audit_logs",
  {
    ...terminalRecordColumns(),
    ...owner(),
    action_type: text().notNull(),
    user_id: uuid().references(() => users.id),
    shift_id: uuid().references(() => shiftOpens.id),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    audit_image_id: uuid(),
  },
  (t) => [uniqueIndex("audit_logs_seq_idx").on(t.terminal_id, t.device_seq), index("audit_logs_store_time_idx").on(t.store_id, t.created_at)]
)

