// Printer-agnostic receipt model, built from the core records. renderReceiptHtml and
// renderReceiptEscPos lay the same document out for a browser/WebView and a thermal printer.
//
// The visible content follows POS-bir's electron/receipt-template.js and its callers
// (app/pos/page.tsx, lib/printer.ts, components/credit/credit-table.tsx): same titles, labels,
// row order and which rows are omitted. Pure TS: no DOM or Node APIs.
import { lessVatOf, roundMoney, toCents } from "../ph-tax"
import type { CreditLedgerEntryRecord, TransactionItemRecord, TransactionRecord } from "../model"

export type ReceiptKind = "sale" | "void" | "payment" | "statement"

export interface ReceiptHeaderLine {
  text: string
  /** The business name: printed bold and large */
  emphasis?: boolean
}

/** A label/value row. A number is a peso amount (2 dp, never wrapped); a string may wrap. */
export interface ReceiptRow {
  label: string
  value: number | string
  /** TOTAL, TOTAL VOIDED, AMOUNT PAID, BALANCE DUE: printed bold and large */
  emphasis?: boolean
}

export interface ReceiptItemLine {
  name: string
  /** Negative on void slips; weights may be fractional (printed up to 3 dp) */
  quantity: number
  /** Printed after the quantity ("1.375 kg"); null for counted items */
  unit: string | null
  /** Printed as "qty x unit price"; null prints the quantity alone */
  unitPrice: number | null
  lineTotal: number
}

export interface ReceiptDocument {
  kind: ReceiptKind
  /** Business name (emphasised), address, TIN, terminal fields, extra header lines */
  header: ReceiptHeaderLine[]
  /** Large line above the title (void slips: "*** VOID ***") */
  banner: string | null
  title: string
  /** Invoice number, date, cashier, customer... */
  meta: ReceiptRow[]
  /** Free-text lines after the meta rows (e.g. the void reason) */
  notes: string[]
  items: ReceiptItemLine[]
  totals: ReceiptRow[]
  vatBreakdown: ReceiptRow[]
  payment: ReceiptRow[]
  footer: string[]
}

/**
 * The store and terminal printed in the header. Every field is optional: a missing one is left
 * off rather than printed as a placeholder. Terminal fields come from terminal registration.
 */
export interface ReceiptBusiness {
  businessName?: string | null
  address?: string | null
  /** Bare numbers print as "VAT REG TIN: ..."; a pre-labelled string prints as given */
  tin?: string | null
  /** Machine identification number, printed "MIN: ..." */
  min?: string | null
  /** Printed "S/N: ..." */
  serialNumber?: string | null
  /** Permit to use, printed "PTU No: ..." */
  ptuNumber?: string | null
  /** Not printed by POS-bir; printed "Accreditation No: ..." when set (label to confirm with BIR) */
  accreditationNumber?: string | null
  /** Extra header lines, printed verbatim after the fields above */
  headerLines?: string[]
  /** Extra footer lines, printed verbatim after each receipt's default footer */
  footerLines?: string[]
}

export interface ReceiptOptions {
  /** IANA zone for printed dates (records store UTC). Default "Asia/Manila". */
  timeZone?: string
}

export interface SaleReceiptOptions extends ReceiptOptions {
  cashierName?: string | null
  /** STORE_CREDIT sales: the customer's name, printed "Charged To" instead of their id */
  creditCustomerName?: string | null
}

export interface VoidSlipOptions extends ReceiptOptions {
  cashierName?: string | null
  /** The approving manager's name (the record only holds their id, which is never printed) */
  authorizedByName?: string | null
}

export interface StatementOptions extends ReceiptOptions {
  /** Print time, shown as the statement date (builders never read the clock) */
  now: Date
  /** E.g. "SOA-000123" from a terminal counter (POS-bir used the last 6 digits of the time in ms, which repeat) */
  statementNumber: string
}

export interface PaymentReceiptOptions extends ReceiptOptions {
  receiptNumber?: string | null
  cashierName?: string | null
  /** Overrides the entry's payment_method (e.g. a display name) */
  paymentMethod?: string | null
  /** Overrides the entry's reference_number */
  referenceNumber?: string | null
  amountTendered?: number | null
  change?: number | null
}

export interface ReceiptCustomer {
  full_name: string
  /** When given, ledger entries for another customer are refused */
  id?: string | null
}

/** A ledger entry plus the invoice number of the sale it came from, if any (as POS-bir's SOA query joins it) */
export type StatementLedgerEntry = Pick<CreditLedgerEntryRecord, "created_at" | "entry_type" | "amount"> & {
  customer_id?: string
  invoice_number?: string | null
}

export type PaymentLedgerEntry = Pick<CreditLedgerEntryRecord, "created_at" | "entry_type" | "amount" | "running_balance"> &
  Partial<Pick<CreditLedgerEntryRecord, "payment_method" | "reference_number">> & {
    customer_id?: string
  }

export const DEFAULT_RECEIPT_TIME_ZONE = "Asia/Manila"
/** Printed after weighed quantities; POS-bir sells and stocks WEIGHT products in kilograms */
export const WEIGHT_UNIT = "kg"
export const NOT_VALID_FOR_INPUT_TAX = "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX"

// ---------------------------------------------------------------------------
// Formatting shared by every renderer, so HTML and paper show identical text.

/** 1234.5 -> "1,234.50", -0.004 -> "0.00" (rounded like roundMoney); "" for a non-finite number. */
export function formatReceiptMoney(amount: number): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return ""
  const cents = Math.abs(toCents(amount))
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const frac = String(cents % 100).padStart(2, "0")
  return (amount < 0 && cents > 0 ? "-" : "") + whole + "." + frac
}

/** Integers as-is; weights up to 3 dp with trailing zeros trimmed. */
export function formatReceiptQuantity(quantity: number): string {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) return ""
  if (Number.isInteger(quantity)) return String(quantity)
  return quantity.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

/** The quantity column of an item: "2 x 65.00", "1.375 kg x 50.00", or the quantity alone without a unit price. */
export function formatReceiptItemDetail(item: Pick<ReceiptItemLine, "quantity" | "unit" | "unitPrice">): string {
  const qty = formatReceiptQuantity(item.quantity) + (item.unit ? ` ${item.unit}` : "")
  const unitPrice = item.unitPrice === null ? "" : formatReceiptMoney(item.unitPrice)
  return unitPrice ? `${qty} x ${unitPrice}` : qty
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()

function cached(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions) {
  let format = cache.get(timeZone)
  if (!format) {
    // Throws RangeError on an unknown zone: better than printing the wrong time
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone })
    cache.set(timeZone, format)
  }
  return format
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "YYYY-MM-DD HH:mm:ss" in the store's zone (POS-bir's receipt format). Unparseable input is returned verbatim. */
export function formatReceiptDate(value: string | Date, timeZone: string = DEFAULT_RECEIPT_TIME_ZONE): string {
  const d = toDate(value)
  if (!d) return String(value)
  const parts: Record<string, string> = {}
  const format = cached(dateTimeFormats, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  for (const p of format.formatToParts(d)) parts[p.type] = p.value
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** "M/D/YYYY" in the store's zone: the short date POS-bir's statement lines use. */
export function formatReceiptShortDate(value: string | Date, timeZone: string = DEFAULT_RECEIPT_TIME_ZONE): string {
  const d = toDate(value)
  if (!d) return String(value)
  return cached(dateFormats, timeZone, { year: "numeric", month: "numeric", day: "numeric" }).format(d)
}

// ---------------------------------------------------------------------------
// Builders

const hasText = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== ""

function textRow(label: string, value: string | null | undefined): ReceiptRow[] {
  return hasText(value) ? [{ label, value: value.trim() }] : []
}

function moneyRow(label: string, value: number | null | undefined, emphasis?: boolean): ReceiptRow[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return []
  return [emphasis ? { label, value, emphasis } : { label, value }]
}

function tinLine(tin: string): string {
  const s = tin.trim()
  // Bare numbers get the BIR label; pre-labelled strings are printed as given.
  return /^[0-9][0-9\s-]*$/.test(s) ? `VAT REG TIN: ${s}` : s
}

function buildHeader(business: ReceiptBusiness): ReceiptHeaderLine[] {
  const lines: ReceiptHeaderLine[] = []
  const add = (text: string | null | undefined, format: (s: string) => string = (s) => s) => {
    if (hasText(text)) lines.push({ text: format(text.trim()) })
  }
  if (hasText(business.businessName)) lines.push({ text: business.businessName.trim(), emphasis: true })
  add(business.address)
  add(business.tin, tinLine)
  add(business.min, (s) => `MIN: ${s}`)
  add(business.serialNumber, (s) => `S/N: ${s}`)
  add(business.ptuNumber, (s) => `PTU No: ${s}`)
  add(business.accreditationNumber, (s) => `Accreditation No: ${s}`)
  for (const l of business.headerLines ?? []) add(l)
  return lines
}

function buildFooter(defaults: string[], business: ReceiptBusiness): string[] {
  return [...defaults, ...(business.footerLines ?? []).filter(hasText).map((l) => l.trim())]
}

function vatRows(t: TransactionRecord): ReceiptRow[] {
  return [
    ...moneyRow("VATable Sales", t.vatable_sales),
    ...moneyRow("VAT Amount", t.vat_amount),
    ...moneyRow("VAT-Exempt Sales", t.vat_exempt_sales),
    ...moneyRow("Zero-Rated Sales", t.zero_rated_sales),
  ]
}

function linesOf(transaction: TransactionRecord, items: TransactionItemRecord[], fn: string) {
  const foreign = items.find((i) => i.transaction_id !== transaction.id)
  if (foreign) throw new Error(`${fn}: item ${foreign.id} belongs to another transaction`)
  return items
}

const unitOf = (item: TransactionItemRecord) => (item.unit_type === "WEIGHT" ? WEIGHT_UNIT : null)

const emptyDocument = (kind: ReceiptKind, title: string): ReceiptDocument => ({
  kind,
  header: [],
  banner: null,
  title,
  meta: [],
  notes: [],
  items: [],
  totals: [],
  vatBreakdown: [],
  payment: [],
  footer: [],
})

/**
 * Sales invoice. Shows Subtotal (gross), Less VAT (SC/PWD; only when there is some), Less Discount
 * and TOTAL, so Subtotal - Less VAT - Less Discount = TOTAL on paper for SC/PWD sales.
 */
export function buildSaleReceipt(
  transaction: TransactionRecord,
  items: TransactionItemRecord[],
  business: ReceiptBusiness = {},
  opts: SaleReceiptOptions = {}
): ReceiptDocument {
  if (transaction.transaction_type !== "SALE") {
    throw new Error("buildSaleReceipt: not a sale (use buildVoidSlip for credit notes)")
  }
  const tz = opts.timeZone ?? DEFAULT_RECEIPT_TIME_ZONE
  const t = transaction
  return {
    ...emptyDocument("sale", "SALES INVOICE"),
    header: buildHeader(business),
    meta: [
      ...textRow("Invoice No", t.invoice_number),
      ...textRow("Date", formatReceiptDate(t.created_at, tz)),
      ...textRow("Cashier", opts.cashierName),
      ...textRow("Customer", t.sc_pwd_name),
      ...textRow("SC/PWD ID", t.sc_pwd_id),
    ],
    // Lines at the price actually charged (e.g. wholesale)
    items: linesOf(t, items, "buildSaleReceipt").map((i) => ({
      name: i.product_name,
      quantity: i.quantity_sold,
      unit: unitOf(i),
      unitPrice: i.price_at_sale,
      lineTotal: roundMoney(i.price_at_sale * i.quantity_sold),
    })),
    totals: [
      ...moneyRow("Subtotal", t.gross_sales),
      ...moneyRow("Less VAT (SC/PWD)", lessVatOf(t)),
      ...moneyRow("Less Discount", t.total_discount),
      ...moneyRow("TOTAL", t.net_sales, true),
    ],
    vatBreakdown: vatRows(t),
    payment: [
      ...textRow("Payment", t.payment_method),
      // A store-credit sale's reference is the customer id: print their name when we have it
      ...(t.payment_method === "STORE_CREDIT" && hasText(opts.creditCustomerName)
        ? textRow("Charged To", opts.creditCustomerName)
        : textRow("Reference No", t.reference_number)),
      ...moneyRow("Amount Tendered", t.amount_tendered),
      ...moneyRow("Change", t.change_amount),
    ],
    footer: buildFooter(["Thank you!"], business),
  }
}

/**
 * Void slip for a credit note: its own CN number, the original invoice, negative lines and amounts.
 * `items` are the original sale's lines (credit notes reference the sale rather than copying them).
 */
export function buildVoidSlip(
  creditNote: TransactionRecord,
  originalSale: TransactionRecord,
  items: TransactionItemRecord[],
  business: ReceiptBusiness = {},
  opts: VoidSlipOptions = {}
): ReceiptDocument {
  if (creditNote.transaction_type !== "VOID_REFUND") throw new Error("buildVoidSlip: not a credit note")
  if (creditNote.original_transaction_id !== originalSale.id) {
    throw new Error("buildVoidSlip: the credit note does not reference this sale")
  }
  const tz = opts.timeZone ?? DEFAULT_RECEIPT_TIME_ZONE
  const cn = creditNote
  const negate = (n: number) => (n === 0 ? 0 : -n)
  return {
    ...emptyDocument("void", "VOID SLIP"),
    header: buildHeader(business),
    banner: "*** VOID ***",
    meta: [
      ...textRow("Void Ref No", cn.invoice_number),
      ...textRow("Orig. Invoice", originalSale.invoice_number),
      ...textRow("Date", formatReceiptDate(cn.created_at, tz)),
      ...textRow("Cashier", opts.cashierName),
      ...textRow("Authorized By", opts.authorizedByName),
    ],
    notes: hasText(cn.void_reason) ? [`Reason: ${cn.void_reason.trim()}`] : [],
    items: linesOf(originalSale, items, "buildVoidSlip").map((i) => ({
      name: i.product_name || "Item",
      quantity: negate(i.quantity_sold),
      unit: unitOf(i),
      unitPrice: i.price_at_sale,
      lineTotal: negate(roundMoney(i.price_at_sale * i.quantity_sold)),
    })),
    // Reversal amounts are already negative; a zero discount is left off (as POS-bir does)
    totals: [
      ...moneyRow("Less VAT (SC/PWD)", lessVatOf(cn)),
      ...moneyRow("Less Discount", cn.total_discount || undefined),
      ...moneyRow("TOTAL VOIDED", cn.net_sales, true),
    ],
    vatBreakdown: vatRows(cn),
    payment: textRow("Orig. Payment", originalSale.payment_method),
    footer: buildFooter([], business),
  }
}

const ENTRY_LABEL: Record<CreditLedgerEntryRecord["entry_type"], string> = {
  CHARGE: "Charge",
  PAYMENT: "Payment",
  ADJUSTMENT: "Adjustment",
}

/**
 * Statement of account: every ledger entry oldest first, charges positive and payments /
 * adjustments negative, so the lines add up to BALANCE DUE (the sum of the entries).
 */
export function buildStatementOfAccount(
  customer: ReceiptCustomer,
  ledgerEntries: StatementLedgerEntry[],
  business: ReceiptBusiness,
  opts: StatementOptions
): ReceiptDocument {
  const tz = opts.timeZone ?? DEFAULT_RECEIPT_TIME_ZONE
  const now = opts.now
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("buildStatementOfAccount: opts.now must be a valid Date")
  if (!hasText(opts.statementNumber)) throw new Error("buildStatementOfAccount: opts.statementNumber is required")
  const foreign = ledgerEntries.find((e) => customer.id && e.customer_id && e.customer_id !== customer.id)
  if (foreign) throw new Error("buildStatementOfAccount: a ledger entry belongs to another customer")

  const time = (e: StatementLedgerEntry) => new Date(e.created_at).getTime() || 0
  const entries = ledgerEntries.map((e, i) => ({ e, i })).sort((a, b) => time(a.e) - time(b.e) || a.i - b.i)
  const items: ReceiptItemLine[] = entries.map(({ e }) => {
    const amount = Number(e.amount)
    const lineTotal = e.entry_type === "CHARGE" ? amount : amount === 0 ? 0 : -amount
    const invoice = hasText(e.invoice_number) ? ` ${e.invoice_number.trim()}` : ""
    return {
      name: `${formatReceiptShortDate(e.created_at, tz)} - ${ENTRY_LABEL[e.entry_type] ?? e.entry_type}${invoice}`,
      quantity: 1,
      unit: null,
      unitPrice: Math.abs(lineTotal),
      lineTotal,
    }
  })
  const balanceCents = items.reduce((sum, item) => sum + toCents(item.lineTotal), 0)

  return {
    ...emptyDocument("statement", "STATEMENT OF ACCOUNT"),
    header: buildHeader(business),
    meta: [
      ...textRow("SOA No", opts.statementNumber),
      ...textRow("Date", formatReceiptDate(now, tz)),
      ...textRow("Customer", customer.full_name),
    ],
    items,
    totals: moneyRow("BALANCE DUE", balanceCents / 100, true),
    footer: buildFooter([NOT_VALID_FOR_INPUT_TAX], business),
  }
}

/**
 * Receipt for a store-credit payment: balance before, amount paid, balance after, and how it was
 * paid (the entry's payment_method / reference_number unless the options override them).
 */
export function buildPaymentReceipt(
  customer: ReceiptCustomer,
  paymentEntry: PaymentLedgerEntry,
  business: ReceiptBusiness = {},
  opts: PaymentReceiptOptions = {}
): ReceiptDocument {
  if (paymentEntry.entry_type !== "PAYMENT") throw new Error("buildPaymentReceipt: not a PAYMENT ledger entry")
  if (customer.id && paymentEntry.customer_id && paymentEntry.customer_id !== customer.id) {
    throw new Error("buildPaymentReceipt: the payment belongs to another customer")
  }
  const tz = opts.timeZone ?? DEFAULT_RECEIPT_TIME_ZONE
  const amount = Number(paymentEntry.amount)
  const newBalance = Number(paymentEntry.running_balance)
  return {
    ...emptyDocument("payment", "PAYMENT RECEIPT"),
    header: buildHeader(business),
    meta: [
      ...textRow("Receipt No", opts.receiptNumber),
      ...textRow("Date", formatReceiptDate(paymentEntry.created_at, tz)),
      ...textRow("Cashier", opts.cashierName),
      ...textRow("Customer", customer.full_name),
    ],
    totals: [
      ...moneyRow("Previous Balance", roundMoney(newBalance + amount)),
      ...moneyRow("AMOUNT PAID", amount, true),
      ...moneyRow("Remaining Balance", newBalance),
    ],
    payment: [
      ...textRow("Payment", opts.paymentMethod ?? paymentEntry.payment_method),
      ...textRow("Reference No", opts.referenceNumber ?? paymentEntry.reference_number),
      ...moneyRow("Amount Tendered", opts.amountTendered),
      ...moneyRow("Change", opts.change),
    ],
    footer: buildFooter([NOT_VALID_FOR_INPUT_TAX, "Thank you!"], business),
  }
}
