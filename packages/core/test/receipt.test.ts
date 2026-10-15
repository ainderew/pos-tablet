// Receipts: the model builders, the HTML renderer and the ESC/POS renderer.
import { describe, expect, it } from "vitest"
import { calculateTransactionTotals, getActivePrice, roundMoney } from "../src/ph-tax"
import {
  CreditLedgerEntryRecordSchema,
  CreditNoteRecordSchema,
  SaleRecordSchema,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
} from "../src/model"
import type { CreditNoteRecord, PaymentMethod, SaleRecord, TransactionItemRecord } from "../src/model"
import type { Product, TaxCategory } from "../src/types"
import {
  buildPaymentReceipt,
  buildSaleReceipt,
  buildStatementOfAccount,
  buildVoidSlip,
  formatReceiptDate,
  formatReceiptMoney,
  formatReceiptQuantity,
  NOT_VALID_FOR_INPUT_TAX,
} from "../src/receipt/model"
import type { ReceiptBusiness, ReceiptDocument, StatementLedgerEntry } from "../src/receipt/model"
import { renderReceiptHtml } from "../src/receipt/html"
import { renderReceiptEscPos, toPrintableText } from "../src/receipt/escpos"
import type { EscPosOptions } from "../src/receipt/escpos"

// ---------------------------------------------------------------------------
// Fixtures: records priced and totalled with the core tax rules (as buildSale does), checked
// against the shared record schemas. Built here rather than through buildSale/buildVoid so these
// tests only depend on the record shapes.

const SOLD_AT = new Date("2026-10-15T03:59:18.390Z") // 11:59:18 in Manila
const VOIDED_AT = new Date("2026-10-15T05:10:00.000Z") // 13:10:00 in Manila

const product = (id: string, name: string, price: number, tax: TaxCategory = "VATABLE", extra: Partial<Product> = {}): Product => ({
  id,
  name,
  barcode: null,
  selling_price: price,
  cost_price: Math.round(price * 70) / 100,
  stock_level: 1000,
  unit_type: "QUANTITY",
  low_stock_threshold: 0,
  notify_low_stock: false,
  category_id: null,
  tax_category: tax,
  supplier_type: "WHOLESALER",
  is_promo: false,
  promo_price: null,
  pos_id: "pos-1",
  is_synced: false,
  ...extra,
})

const PRODUCTS = new Map(
  [
    product("coke", "Coke 1.5L", 65),
    product("rice", "Dinorado Rice (kg)", 50, "VATABLE", { unit_type: "WEIGHT" }),
    product("beef", "Wagyu Beef Striploin", 1234.5, "VATABLE", { unit_type: "WEIGHT" }),
    product("milk", "Bear Brand Milk 300g", 85, "VAT_EXEMPT"),
    product("sardines", "Ligo Sardines", 24, "VATABLE", { wholesale_price: 22, wholesale_threshold: 10 }),
    product("eggs", "Fresh Eggs (tray)", 230, "ZERO_RATED"),
    product("long", "Super Extra Long Product Name For The Wrapping Test 1.5 Liter Family Pack", 1234.5),
  ].map((p) => [p.id, p])
)

interface SaleSpec {
  paymentMethod?: PaymentMethod
  amountTendered?: number
  referenceNumber?: string
  paxCount?: number
  seniorCount?: number
  scPwd?: { idNumber: string; name: string }
}

let seq = 0 // ids and device_seq, unique across calls
const base = (at: Date) => ({ id: `rec-${++seq}`, store_id: "store-1", terminal_id: "terminal-1", device_seq: seq, created_at: at.toISOString() })

function sell(lines: { productId: string; quantity: number }[], spec: SaleSpec = {}): { transaction: SaleRecord; items: TransactionItemRecord[] } {
  const cart = lines.map(({ productId, quantity }) => {
    const p = PRODUCTS.get(productId)!
    return { product: p, quantity, active_price: getActivePrice(p, quantity) }
  })
  const paxCount = spec.paxCount ?? 1
  const seniorCount = spec.seniorCount ?? 0
  const totals = calculateTransactionTotals(cart, paxCount, seniorCount)
  const tendered = spec.amountTendered ?? null
  const transaction = SaleRecordSchema.parse({
    ...base(SOLD_AT),
    shift_id: "shift-1",
    cashier_id: "cashier-1",
    invoice_number: "SI-000042",
    transaction_type: "SALE",
    status: "PAID",
    original_transaction_id: null,
    void_reason: null,
    authorized_by: null,
    gross_sales: totals.grossSales,
    vatable_sales: totals.vatableSales,
    vat_amount: totals.vatAmount,
    vat_exempt_sales: totals.vatExemptSales,
    zero_rated_sales: totals.zeroRatedSales,
    total_discount: totals.totalDiscount,
    net_sales: totals.netSales,
    pax_count: paxCount,
    senior_count: seniorCount,
    sc_pwd_id: spec.scPwd?.idNumber ?? null,
    sc_pwd_name: spec.scPwd?.name ?? null,
    payment_method: spec.paymentMethod ?? "CASH",
    amount_tendered: tendered,
    change_amount: tendered === null ? 0 : roundMoney(tendered - totals.netSales),
    reference_number: spec.referenceNumber ?? null,
  })
  TransactionRecordSchema.parse(transaction) // the cross-field rules (SC/PWD ID, seniors <= pax)
  const items = cart.map((c) =>
    TransactionItemRecordSchema.parse({
      ...base(SOLD_AT),
      transaction_id: transaction.id,
      product_id: c.product.id,
      product_name: c.product.name,
      unit_type: c.product.unit_type,
      quantity_sold: c.quantity,
      price_at_sale: c.active_price,
      cost_at_sale: c.product.cost_price,
      tax_category: c.product.tax_category,
    })
  )
  return { transaction, items }
}

const negate = (n: number) => (n === 0 ? 0 : -n)

/** The credit note voiding a sale: every amount negated, as buildVoid issues it */
function voidOf(sale: { transaction: SaleRecord }, reason: string | null = "Wrong item scanned"): CreditNoteRecord {
  const t = sale.transaction
  const creditNote = CreditNoteRecordSchema.parse({
    ...t,
    ...base(VOIDED_AT),
    invoice_number: "CN-000007",
    transaction_type: "VOID_REFUND",
    status: "REFUND",
    original_transaction_id: t.id,
    void_reason: reason,
    authorized_by: "manager-1",
    gross_sales: negate(t.gross_sales),
    vatable_sales: negate(t.vatable_sales),
    vat_amount: negate(t.vat_amount),
    vat_exempt_sales: negate(t.vat_exempt_sales),
    zero_rated_sales: negate(t.zero_rated_sales),
    total_discount: negate(t.total_discount),
    net_sales: negate(t.net_sales),
    amount_tendered: 0,
    change_amount: 0,
    reference_number: t.invoice_number,
  })
  TransactionRecordSchema.parse(creditNote)
  return creditNote
}

const BUSINESS: ReceiptBusiness = {
  businessName: "Aling Nena's Sari-Sari Store",
  address: "123 Rizal Ave, Brgy. San Jose, Quezon City",
  tin: "123-456-789-000",
  min: "MIN-0001",
  serialNumber: "SN-TAB-9",
  ptuNumber: "PTU-77",
}

const cashSale = () =>
  sell(
    [
      { productId: "coke", quantity: 2 },
      { productId: "rice", quantity: 1.25 },
      { productId: "sardines", quantity: 10 }, // wholesale price
    ],
    { paymentMethod: "CASH", amountTendered: 500 }
  )

// SC/PWD group sale: 1 senior of 2, VATABLE + VAT-exempt + zero-rated lines
const scPwdSale = () =>
  sell(
    [
      { productId: "coke", quantity: 3 },
      { productId: "milk", quantity: 2 },
      { productId: "eggs", quantity: 1 },
    ],
    { paxCount: 2, seniorCount: 1, scPwd: { idNumber: "OSCA-12345", name: "Lolo Ben" }, amountTendered: 1000 }
  )

const LEDGER: StatementLedgerEntry[] = [
  // Deliberately out of order: the statement prints oldest first
  { created_at: "2026-10-05T02:00:00.000Z", entry_type: "PAYMENT", amount: 100, invoice_number: null },
  { created_at: "2026-09-30T17:00:00.000Z", entry_type: "CHARGE", amount: 250, invoice_number: "SI-000040" }, // Oct 1 in Manila
  { created_at: "2026-10-07T03:00:00.000Z", entry_type: "CHARGE", amount: 75.5, invoice_number: "SI-000051" },
  { created_at: "2026-10-08T03:00:00.000Z", entry_type: "ADJUSTMENT", amount: 25, invoice_number: "CN-000003" },
]
const statement = (business = BUSINESS) =>
  buildStatementOfAccount({ full_name: "Juan Dela Cruz" }, LEDGER, business, {
    now: new Date("2026-10-15T08:00:00.000Z"),
    statementNumber: "SOA-123456",
  })

// A PAYMENT entry as buildCreditPayment writes it, checked against the shared schema
const PAYMENT_ENTRY = CreditLedgerEntryRecordSchema.parse({
  ...base(new Date("2026-10-15T06:00:00.000Z")),
  customer_id: "cust-1",
  transaction_id: null,
  shift_id: "shift-1",
  entry_type: "PAYMENT",
  amount: 1000,
  running_balance: 500,
  notes: null,
  payment_method: "GCASH",
  reference_number: "GC-998877",
})

const paymentReceipt = (business = BUSINESS) =>
  buildPaymentReceipt({ id: "cust-1", full_name: "Juan Dela Cruz" }, PAYMENT_ENTRY, business, {
    receiptNumber: "PR-000007",
    cashierName: "Maria",
    amountTendered: 1000,
    change: 0,
  })

// ---------------------------------------------------------------------------
// Helpers: visible text of the HTML, and a strict ESC/POS decoder

/** Body text with tags stripped, entities decoded, whitespace collapsed (as POS-bir's tests do). */
function htmlText(html: string): string {
  return html
    .slice(html.indexOf("<body>"))
    .replace(/<\/(td|tr|div)>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

interface PrintedLine {
  text: string
  bold: boolean
  size: number
  align: number
}

const CP437_SAMPLE: Record<number, string> = { 0x81: "ü", 0x82: "é", 0x8f: "Å", 0xa0: "á", 0xa4: "ñ", 0xa5: "Ñ" }

/** Walks the bytes, accepting only the commands the renderer may emit; any stray control byte throws. */
function decodeEscPos(bytes: Uint8Array) {
  const lines: PrintedLine[] = []
  const commands: string[] = []
  let text = ""
  let bold = false
  let size = 0
  let align = 0
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b === 0x1b) {
      const c = bytes[i + 1]
      if (c === 0x40) {
        commands.push("init")
        bold = false
        size = 0
        align = 0
        i += 2
        continue
      }
      const n = bytes[i + 2]
      if (c === 0x74) commands.push(`codepage ${n}`)
      else if (c === 0x61) align = n
      else if (c === 0x45) commands.push(`bold ${(bold = n === 1) ? "on" : "off"}`)
      else if (c === 0x64) commands.push(`feed ${n}`)
      else throw new Error(`unexpected ESC 0x${c.toString(16)} at ${i}`)
      i += 3
    } else if (b === 0x1d && bytes[i + 1] === 0x21) {
      size = bytes[i + 2]
      i += 3
    } else if (b === 0x1d && bytes[i + 1] === 0x56 && bytes[i + 2] === 0x42) {
      commands.push(`cut ${bytes[i + 3]}`)
      i += 4
    } else if (b === 0x1c && bytes[i + 1] === 0x2e) {
      commands.push("cancel kanji")
      i += 2
    } else if (b === 0x0a) {
      lines.push({ text, bold, size, align })
      text = ""
      i++
    } else if (b < 0x20 || b === 0x7f) {
      throw new Error(`stray control byte 0x${b.toString(16)} at ${i}`)
    } else {
      text += b < 0x80 ? String.fromCharCode(b) : (CP437_SAMPLE[b] ?? "#")
      i++
    }
  }
  if (text) throw new Error("text after the last line feed")
  return { lines, commands }
}

const printedWidth = (l: PrintedLine) => l.text.length * (l.size & 0x10 ? 2 : 1)

function escpos(doc: ReceiptDocument, options: Partial<EscPosOptions> = {}) {
  const bytes = renderReceiptEscPos(doc, { paperWidth: 58, ...options })
  return { bytes, ...decodeEscPos(bytes) }
}

/** Printed text minus rules, joined and collapsed: comparable with htmlText */
const escposText = (lines: PrintedLine[]) =>
  lines
    .map((l) => l.text)
    .filter((t) => !/^-+$/.test(t))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100)

/** The amount printed after `label` (first match) */
function amountAfter(text: string, label: string): number {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = text.match(new RegExp(`${escaped}\\s+(-?[\\d,]+\\.\\d{2})`))
  if (!m) throw new Error(`no amount for ${label} in: ${text}`)
  return cents(m[1])
}

const indexOfBytes = (haystack: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

// ---------------------------------------------------------------------------

describe("receipt formatting", () => {
  it.each([
    [0, "0.00"],
    [5, "5.00"],
    [1234.5, "1,234.50"],
    [1234567.891, "1,234,567.89"],
    [1.005, "1.01"],
    [0.1 + 0.2, "0.30"],
    [-192.5, "-192.50"],
    [-0.004, "0.00"],
    [NaN, ""],
    [Infinity, ""],
  ])("money %p -> %p", (amount, expected) => {
    expect(formatReceiptMoney(amount)).toBe(expected)
  })

  it("prints integer quantities as-is and weights to at most 3 dp", () => {
    expect(formatReceiptQuantity(2)).toBe("2")
    expect(formatReceiptQuantity(-3)).toBe("-3")
    expect(formatReceiptQuantity(1.25)).toBe("1.25")
    expect(formatReceiptQuantity(0.3333333)).toBe("0.333")
  })

  it("formats UTC records in the store's zone (Asia/Manila by default)", () => {
    expect(formatReceiptDate("2026-10-15T03:59:18.390Z")).toBe("2026-10-15 11:59:18")
    expect(formatReceiptDate("2026-10-15T16:30:00Z")).toBe("2026-10-16 00:30:00") // next day, hour 00 not 24
    expect(formatReceiptDate("2026-10-15T03:59:18Z", "UTC")).toBe("2026-10-15 03:59:18")
    expect(formatReceiptDate(new Date("2026-01-02T03:04:05Z"), "Asia/Tokyo")).toBe("2026-01-02 12:04:05")
    expect(formatReceiptDate("not a date")).toBe("not a date")
    expect(() => formatReceiptDate("2026-10-15T03:59:18Z", "Mars/Olympus")).toThrow(RangeError)
  })
})

describe("receipt model builders", () => {
  it("builds a sales invoice with POS-bir's content", () => {
    const { transaction, items } = cashSale()
    const doc = buildSaleReceipt(transaction, items, { ...BUSINESS, accreditationNumber: "ACC-1", headerLines: ["Branch 2"], footerLines: ["Come again!"] }, { cashierName: "Maria" })
    expect(doc.kind).toBe("sale")
    expect(doc.title).toBe("SALES INVOICE")
    expect(doc.banner).toBeNull()
    expect(doc.header).toEqual([
      { text: "Aling Nena's Sari-Sari Store", emphasis: true },
      { text: "123 Rizal Ave, Brgy. San Jose, Quezon City" },
      { text: "VAT REG TIN: 123-456-789-000" },
      { text: "MIN: MIN-0001" },
      { text: "S/N: SN-TAB-9" },
      { text: "PTU No: PTU-77" },
      { text: "Accreditation No: ACC-1" },
      { text: "Branch 2" },
    ])
    expect(doc.meta).toEqual([
      { label: "Invoice No", value: "SI-000042" },
      { label: "Date", value: "2026-10-15 11:59:18" },
      { label: "Cashier", value: "Maria" },
    ])
    expect(doc.items).toEqual([
      { name: "Coke 1.5L", quantity: 2, unit: null, unitPrice: 65, lineTotal: 130 },
      { name: "Dinorado Rice (kg)", quantity: 1.25, unit: "kg", unitPrice: 50, lineTotal: 62.5 },
      { name: "Ligo Sardines", quantity: 10, unit: null, unitPrice: 22, lineTotal: 220 },
    ])
    expect(doc.totals).toEqual([
      { label: "Subtotal", value: 412.5 },
      { label: "Less Discount", value: 0 }, // POS-bir prints it even when zero; Less VAT only for SC/PWD
      { label: "TOTAL", value: 412.5, emphasis: true },
    ])
    expect(doc.vatBreakdown.map((r) => r.label)).toEqual(["VATable Sales", "VAT Amount", "VAT-Exempt Sales", "Zero-Rated Sales"])
    expect(doc.payment).toEqual([
      { label: "Payment", value: "CASH" },
      { label: "Amount Tendered", value: 500 },
      { label: "Change", value: 87.5 },
    ])
    expect(doc.footer).toEqual(["Thank you!", "Come again!"])
  })

  it("leaves missing business fields off and labels only bare TINs", () => {
    const { transaction, items } = cashSale()
    expect(buildSaleReceipt(transaction, items).header).toEqual([])
    const labelled = buildSaleReceipt(transaction, items, { tin: "NON-VAT REG TIN: 000-000-000-000", min: "  " })
    expect(labelled.header).toEqual([{ text: "NON-VAT REG TIN: 000-000-000-000" }])
  })

  it("adds SC/PWD name and ID, Less VAT and the discount", () => {
    const { transaction, items } = scPwdSale()
    const doc = buildSaleReceipt(transaction, items, BUSINESS)
    expect(doc.meta).toContainEqual({ label: "Customer", value: "Lolo Ben" })
    expect(doc.meta).toContainEqual({ label: "SC/PWD ID", value: "OSCA-12345" })
    expect(doc.totals.map((r) => r.label)).toEqual(["Subtotal", "Less VAT (SC/PWD)", "Less Discount", "TOTAL"])
    const [subtotal, lessVat, discount, total] = doc.totals.map((r) => Math.round((r.value as number) * 100))
    expect(lessVat).toBeGreaterThan(0)
    expect(discount).toBeGreaterThan(0)
    expect(subtotal - lessVat - discount).toBe(total)
  })

  it("refuses a credit note or lines from another sale", () => {
    const sale = cashSale()
    const creditNote = voidOf(sale)
    expect(() => buildSaleReceipt(creditNote, sale.items)).toThrow(/not a sale/)
    const other = scPwdSale()
    expect(() => buildSaleReceipt(sale.transaction, [...sale.items, other.items[0]])).toThrow(/another transaction/)
  })

  it("builds a void slip with negative lines and the original invoice", () => {
    const sale = scPwdSale()
    const creditNote = voidOf(sale)
    const doc = buildVoidSlip(creditNote, sale.transaction, sale.items, BUSINESS, { cashierName: "Maria", authorizedByName: "Manager Jose" })
    expect(doc.banner).toBe("*** VOID ***")
    expect(doc.title).toBe("VOID SLIP")
    expect(doc.meta).toEqual([
      { label: "Void Ref No", value: "CN-000007" },
      { label: "Orig. Invoice", value: "SI-000042" },
      { label: "Date", value: "2026-10-15 13:10:00" },
      { label: "Cashier", value: "Maria" },
      { label: "Authorized By", value: "Manager Jose" },
    ])
    expect(doc.notes).toEqual(["Reason: Wrong item scanned"])
    expect(doc.items.every((i) => i.quantity < 0 && i.lineTotal < 0 && (i.unitPrice ?? 0) > 0)).toBe(true)
    expect(doc.totals.map((r) => r.label)).toEqual(["Less VAT (SC/PWD)", "Less Discount", "TOTAL VOIDED"])
    expect(doc.totals.every((r) => (r.value as number) < 0)).toBe(true)
    expect(doc.totals[2].value).toBe(-sale.transaction.net_sales)
    expect(doc.payment).toEqual([{ label: "Orig. Payment", value: "CASH" }])
    expect(doc.footer).toEqual([])
  })

  it("omits a zero discount on a regular void and never prints the manager's id", () => {
    const sale = cashSale()
    const doc = buildVoidSlip(voidOf(sale, null), sale.transaction, sale.items)
    expect(doc.totals).toEqual([{ label: "TOTAL VOIDED", value: -412.5, emphasis: true }])
    expect(doc.notes).toEqual([])
    expect(JSON.stringify(doc)).not.toContain("manager-1")
  })

  it("refuses a void slip for the wrong sale or a sale passed as the credit note", () => {
    const sale = cashSale()
    const other = scPwdSale()
    expect(() => buildVoidSlip(voidOf(sale), other.transaction, other.items)).toThrow(/does not reference/)
    expect(() => buildVoidSlip(sale.transaction, sale.transaction, sale.items)).toThrow(/not a credit note/)
  })

  it("builds a statement whose lines add up to the balance due", () => {
    const doc = statement()
    expect(doc.title).toBe("STATEMENT OF ACCOUNT")
    expect(doc.meta).toEqual([
      { label: "SOA No", value: "SOA-123456" },
      { label: "Date", value: "2026-10-15 16:00:00" },
      { label: "Customer", value: "Juan Dela Cruz" },
    ])
    expect(doc.items.map((i) => [i.name, i.lineTotal])).toEqual([
      ["10/1/2026 - Charge SI-000040", 250],
      ["10/5/2026 - Payment", -100],
      ["10/7/2026 - Charge SI-000051", 75.5],
      ["10/8/2026 - Adjustment CN-000003", -25],
    ])
    const sum = doc.items.reduce((s, i) => s + Math.round(i.lineTotal * 100), 0)
    expect(doc.totals).toEqual([{ label: "BALANCE DUE", value: 200.5, emphasis: true }])
    expect(Math.round((doc.totals[0].value as number) * 100)).toBe(sum)
    expect(doc.footer).toEqual([NOT_VALID_FOR_INPUT_TAX])
    expect(doc.vatBreakdown).toEqual([])
  })

  it("is pure: the print time and statement number come from the caller", () => {
    const opts = { now: new Date("2026-10-15T08:00:00.000Z"), statementNumber: "SOA-000001" }
    const doc = buildStatementOfAccount({ full_name: "X" }, [], {}, opts)
    expect(doc.meta.slice(0, 2)).toEqual([
      { label: "SOA No", value: "SOA-000001" },
      { label: "Date", value: "2026-10-15 16:00:00" },
    ])
    expect(doc.totals).toEqual([{ label: "BALANCE DUE", value: 0, emphasis: true }])
    expect(buildStatementOfAccount({ full_name: "X" }, [], {}, opts)).toEqual(doc)
    expect(() => buildStatementOfAccount({ full_name: "X" }, [], {}, { ...opts, now: new Date(NaN) })).toThrow(/valid Date/)
    expect(() => buildStatementOfAccount({ full_name: "X" }, [], {}, { ...opts, statementNumber: " " })).toThrow(/statementNumber/)
    expect(() =>
      buildStatementOfAccount({ id: "a", full_name: "X" }, [{ ...LEDGER[0], customer_id: "b" }], {}, opts)
    ).toThrow(/another customer/)
  })

  it("builds a payment receipt with the balance before and after", () => {
    const doc = paymentReceipt()
    expect(doc.title).toBe("PAYMENT RECEIPT")
    expect(doc.meta).toEqual([
      { label: "Receipt No", value: "PR-000007" },
      { label: "Date", value: "2026-10-15 14:00:00" },
      { label: "Cashier", value: "Maria" },
      { label: "Customer", value: "Juan Dela Cruz" },
    ])
    expect(doc.totals).toEqual([
      { label: "Previous Balance", value: 1500 },
      { label: "AMOUNT PAID", value: 1000, emphasis: true },
      { label: "Remaining Balance", value: 500 },
    ])
    expect(doc.payment).toEqual([
      { label: "Payment", value: "GCASH" },
      { label: "Reference No", value: "GC-998877" },
      { label: "Amount Tendered", value: 1000 },
      { label: "Change", value: 0 },
    ])
    expect(doc.footer).toEqual([NOT_VALID_FOR_INPUT_TAX, "Thank you!"])
    expect(() =>
      buildPaymentReceipt({ full_name: "X" }, { created_at: SOLD_AT.toISOString(), entry_type: "CHARGE", amount: 1, running_balance: 1 })
    ).toThrow(/not a PAYMENT/)
  })

  it("prints how a payment was made from the ledger entry itself, unless the options override it", () => {
    const entry = PAYMENT_ENTRY
    expect(buildPaymentReceipt({ full_name: "Juan" }, entry).payment).toEqual([
      { label: "Payment", value: "GCASH" },
      { label: "Reference No", value: "GC-998877" },
    ])
    expect(buildPaymentReceipt({ full_name: "Juan" }, entry, {}, { paymentMethod: "GCash", referenceNumber: "X-1" }).payment).toEqual([
      { label: "Payment", value: "GCash" },
      { label: "Reference No", value: "X-1" },
    ])
    expect(buildPaymentReceipt({ full_name: "Juan" }, { ...entry, payment_method: "CASH", reference_number: null }).payment).toEqual([
      { label: "Payment", value: "CASH" },
    ])
  })
})

describe("renderReceiptHtml", () => {
  it("produces a static, script-free, monospace document for 72mm/58mm paper", () => {
    const { transaction, items } = cashSale()
    const html = renderReceiptHtml(buildSaleReceipt(transaction, items, BUSINESS))
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`)
    expect(html).toContain("width:72mm;max-width:100%")
    expect(html).toContain("monospace")
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/background/i)
  })

  it("escapes every injected value", () => {
    const evil = `<img src=x onerror="alert('1')">&`
    const escaped = "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;"
    const business: ReceiptBusiness = {
      businessName: evil,
      address: evil,
      tin: evil,
      min: evil,
      serialNumber: evil,
      ptuNumber: evil,
      accreditationNumber: evil,
      headerLines: [evil],
      footerLines: [evil],
    }
    const sale = sell([{ productId: "coke", quantity: 1 }], {
      paymentMethod: "GCASH",
      referenceNumber: evil,
      seniorCount: 1,
      scPwd: { idNumber: evil, name: evil },
    })
    sale.items[0] = { ...sale.items[0], product_name: evil }
    const html = renderReceiptHtml(buildSaleReceipt(sale.transaction, sale.items, business, { cashierName: evil }))
    expect(html).not.toContain("<img")
    expect(html).not.toContain(`"alert`)
    // 9 business fields + cashier, customer, SC/PWD ID, item name, reference number
    expect(html.split(escaped).length - 1).toBe(14)

    const slip = renderReceiptHtml(
      buildVoidSlip({ ...voidOf(sale), void_reason: evil }, sale.transaction, sale.items, {}, { authorizedByName: evil, cashierName: evil })
    )
    expect(slip).not.toContain("<img")
    expect(slip.split(escaped).length - 1).toBe(4) // reason, authorized by, cashier, item name

    const soa = renderReceiptHtml(
      buildStatementOfAccount({ full_name: evil }, [{ ...LEDGER[1], invoice_number: evil }], {}, { now: SOLD_AT, statementNumber: "SOA-000001" })
    )
    expect(soa).not.toContain("<img")
    expect(soa.split(escaped).length - 1).toBe(2)
  })

  it("prints Subtotal - Less VAT - Less Discount = TOTAL on an SC/PWD sale", () => {
    const { transaction, items } = scPwdSale()
    const out = htmlText(renderReceiptHtml(buildSaleReceipt(transaction, items, BUSINESS)))
    const subtotal = amountAfter(out, "Subtotal")
    const lessVat = amountAfter(out, "Less VAT (SC/PWD)")
    const discount = amountAfter(out, "Less Discount")
    const total = amountAfter(out, "TOTAL")
    expect(lessVat).toBeGreaterThan(0)
    expect(subtotal - lessVat - discount).toBe(total)
    expect(total).toBe(Math.round(transaction.net_sales * 100))
    expect(out).toContain("Customer Lolo Ben")
    expect(out).toContain("SC/PWD ID OSCA-12345")
  })

  it("prints weighed quantities with their unit", () => {
    const sale = sell([{ productId: "rice", quantity: 1.375 }, { productId: "coke", quantity: 2 }])
    const out = htmlText(renderReceiptHtml(buildSaleReceipt(sale.transaction, sale.items)))
    expect(out).toContain("Dinorado Rice (kg) 1.375 kg x 50.00 68.75")
    expect(out).toContain("Coke 1.5L 2 x 65.00 130.00")
    const slip = htmlText(renderReceiptHtml(buildVoidSlip(voidOf(sale), sale.transaction, sale.items)))
    expect(slip).toContain("Dinorado Rice (kg) -1.375 kg x 50.00 -68.75")
  })

  it("prints a void slip with negatives and the original invoice", () => {
    const sale = scPwdSale()
    const out = htmlText(
      renderReceiptHtml(buildVoidSlip(voidOf(sale), sale.transaction, sale.items, BUSINESS, { authorizedByName: "Manager Jose" }))
    )
    expect(out).toContain("*** VOID *** VOID SLIP")
    expect(out).toContain("Void Ref No CN-000007")
    expect(out).toContain("Orig. Invoice SI-000042")
    expect(out).toContain("Authorized By Manager Jose")
    expect(out).toContain("Reason: Wrong item scanned")
    expect(out).toContain("Coke 1.5L -3 x 65.00 -195.00")
    expect(out).toContain(`TOTAL VOIDED -${formatReceiptMoney(sale.transaction.net_sales)}`)
    expect(amountAfter(out, "Less VAT (SC/PWD)")).toBeLessThan(0)
    expect(amountAfter(out, "Less Discount")).toBeLessThan(0)
    expect(out).toContain("Orig. Payment CASH")
    expect(out).not.toContain("SALES INVOICE")
  })
})

describe("renderReceiptEscPos", () => {
  const docs = (): [string, ReceiptDocument][] => {
    const sale = scPwdSale()
    const long = sell([{ productId: "long", quantity: 1 }, { productId: "rice", quantity: 0.333 }], { paymentMethod: "MAYA", referenceNumber: "MAYA-REF-0000111122223333" })
    return [
      ["sale", buildSaleReceipt(sale.transaction, sale.items, BUSINESS, { cashierName: "Maria Clara de los Santos" })],
      ["long sale", buildSaleReceipt(long.transaction, long.items, BUSINESS)],
      ["void", buildVoidSlip(voidOf(sale, "Customer changed their mind about the whole purchase"), sale.transaction, sale.items, BUSINESS, { authorizedByName: "Manager Jose" })],
      ["statement", statement()],
      ["payment", paymentReceipt()],
    ]
  }

  it("initialises the printer, selects the code page, and feeds without cutting by default", () => {
    const { transaction, items } = cashSale()
    const doc = buildSaleReceipt(transaction, items, BUSINESS)
    const plain = renderReceiptEscPos(doc, { paperWidth: 58 })
    expect(Array.from(plain.slice(0, 5))).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x00]) // ESC @, ESC t 0 (CP437)
    expect(Array.from(plain.slice(-3))).toEqual([0x1b, 0x64, 0x04]) // ESC d 4
    expect(indexOfBytes(plain, [0x1d, 0x56])).toBe(-1)

    const cut = renderReceiptEscPos(doc, { paperWidth: 80, cut: true, feedLines: 2 })
    expect(Array.from(cut.slice(-7))).toEqual([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x42, 0x00]) // ESC d 2, GS V 66 0

    expect(Array.from(renderReceiptEscPos(doc, { paperWidth: 58, codePage: "wpc1252" }).slice(0, 5))).toEqual([0x1b, 0x40, 0x1b, 0x74, 16])
    expect(Array.from(renderReceiptEscPos(doc, { paperWidth: 58, codePageNumber: 3 }).slice(2, 5))).toEqual([0x1b, 0x74, 3])
    expect(Array.from(renderReceiptEscPos(doc, { paperWidth: 58, cancelKanji: true }).slice(0, 7))).toEqual([0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, 0x00])
  })

  it("prints the business name, title and TOTAL bold and large, and turns bold off again", () => {
    const { transaction, items } = cashSale()
    const { lines, commands } = escpos(buildSaleReceipt(transaction, items, BUSINESS))
    const find = (re: RegExp) => lines.find((l) => re.test(l.text))!
    expect(find(/^Aling Nena/)).toMatchObject({ bold: true, size: 0x01, align: 1 })
    expect(find(/^SALES INVOICE$/)).toMatchObject({ bold: true, size: 0x01, align: 1 })
    expect(find(/^TOTAL /)).toMatchObject({ bold: true, size: 0x01, align: 0 })
    expect(find(/^Subtotal /)).toMatchObject({ bold: false, size: 0x00 })
    expect(find(/^Invoice No /)).toMatchObject({ bold: false, size: 0x00, align: 0 })
    expect(commands.filter((c) => c === "bold on").length).toBe(commands.filter((c) => c === "bold off").length)
    expect(commands.at(-1)).toBe("feed 4")
    // ESC E 1 ... ESC E 0 and GS ! 1 ... GS ! 0 around the TOTAL row
    const bytes = renderReceiptEscPos(buildSaleReceipt(transaction, items, BUSINESS), { paperWidth: 58 })
    const total = indexOfBytes(bytes, Array.from("TOTAL", (c) => c.charCodeAt(0)))
    expect(Array.from(bytes.slice(total - 6, total))).toEqual([0x1b, 0x45, 0x01, 0x1d, 0x21, 0x01])
    expect(indexOfBytes(bytes.slice(total), [0x1b, 0x45, 0x00])).toBeGreaterThan(0)
    expect(indexOfBytes(bytes.slice(total), [0x1d, 0x21, 0x00])).toBeGreaterThan(0)
  })

  it.each([
    [58, 32],
    [80, 48],
  ] as const)("fits every line in %imm paper (%i columns)", (paperWidth, width) => {
    for (const [name, doc] of docs()) {
      const { lines } = escpos(doc, { paperWidth })
      for (const l of lines) {
        expect(printedWidth(l), `${name}: "${l.text}"`).toBeLessThanOrEqual(width)
      }
      expect(lines.filter((l) => /^-+$/.test(l.text)).every((l) => l.text.length === width)).toBe(true)
      // Label/amount rows are spread to the full width, amount flush right
      const total = lines.find((l) => /^(TOTAL|TOTAL VOIDED|BALANCE DUE|AMOUNT PAID) /.test(l.text))!
      expect(total.text).toMatch(/ -?[\d,]+\.\d{2}$/)
      expect(total.text.length).toBe(width)
    }
  })

  it("honours a column override (e.g. 42-column 80mm heads)", () => {
    const { lines } = escpos(statement(), { paperWidth: 80, columns: 42 })
    expect(Math.max(...lines.map(printedWidth))).toBe(42)
    expect(() => renderReceiptEscPos(statement(), { paperWidth: 57 as 58 })).toThrow(RangeError)
  })

  it("shows the same text as the HTML receipt", () => {
    for (const [name, doc] of docs().filter(([n]) => n !== "long sale")) {
      const html = htmlText(renderReceiptHtml(doc))
      for (const paperWidth of [58, 80] as const) {
        expect(escposText(escpos(doc, { paperWidth }).lines), `${name} @ ${paperWidth}mm`).toBe(html)
      }
    }
  })

  it("word-wraps long item names and splits words longer than a line", () => {
    const sale = sell([{ productId: "long", quantity: 1 }])
    sale.items[0] = { ...sale.items[0], product_name: "Ultra Long Product Name For Testing Wrapping " + "X".repeat(40) }
    const { lines } = escpos(buildSaleReceipt(sale.transaction, sale.items, BUSINESS))
    const start = lines.findIndex((l) => l.text.startsWith("Ultra"))
    expect(lines.slice(start, start + 4).map((l) => l.text)).toEqual([
      "Ultra Long Product Name For",
      "Testing Wrapping",
      "X".repeat(32),
      "X".repeat(8),
    ])
    expect(lines[start + 4].text).toMatch(/^ {2}1 x 1,234\.50 +1,234\.50$/)
    expect(lines[start + 4].text.length).toBe(32)
  })

  it.each([
    [58, 32],
    [80, 48],
  ] as const)("prints weighed quantities with their unit within %imm (%i columns)", (paperWidth, width) => {
    const sale = sell([
      { productId: "rice", quantity: 1.375 },
      { productId: "beef", quantity: 12.345 }, // 12.345 kg x 1,234.50 = 15,239.90
      { productId: "rice", quantity: 0.5 },
    ])
    const detailLines = (doc: ReceiptDocument) =>
      escpos(doc, { paperWidth }).lines.filter((l) => /^ {2}-?\d/.test(l.text) || /^ +-?[\d,]+\.\d{2}$/.test(l.text))
    const sold = detailLines(buildSaleReceipt(sale.transaction, sale.items))
    const voided = detailLines(buildVoidSlip(voidOf(sale), sale.transaction, sale.items))
    for (const l of [...sold, ...voided]) expect(l.text.length, l.text).toBeLessThanOrEqual(width)

    expect(sold[0].text).toMatch(/^ {2}1\.375 kg x 50\.00 +68\.75$/)
    expect(voided[0].text).toMatch(/^ {2}-1\.375 kg x 50\.00 +-68\.75$/)
    expect(sold.at(-1)!.text).toMatch(/^ {2}0\.5 kg x 50\.00 +25\.00$/)
    if (width === 32) {
      // "  -12.345 kg x 1,234.50" and "-15,239.90" don't fit on one 32-column line: the total goes under it
      expect(voided.slice(1, 3).map((l) => l.text)).toEqual(["  -12.345 kg x 1,234.50", "-15,239.90".padStart(32)])
    } else {
      expect(voided[1].text).toMatch(/^ {2}-12\.345 kg x 1,234\.50 +-15,239\.90$/)
      expect(voided[1].text.length).toBe(48)
    }
  })

  it("wraps long text values beside their label and keeps amounts whole", () => {
    const sale = sell([{ productId: "coke", quantity: 1 }], { paymentMethod: "CARD", referenceNumber: "AUTH 000111 222333 444555 666777" })
    const { lines } = escpos(buildSaleReceipt(sale.transaction, sale.items, {}, { cashierName: "Maria" }))
    const i = lines.findIndex((l) => l.text.startsWith("Reference No"))
    expect(lines[i].text).toBe("Reference No  AUTH 000111 222333")
    expect(lines[i + 1].text).toBe(" ".repeat(19) + "444555 666777")
  })

  it("maps Latin-1 letters to CP437 and falls back safely for everything else", () => {
    const smile = String.fromCodePoint(0x1f600)
    expect(toPrintableText("Piña ₱5 “Best” ‘café’ — Ñoño… Ångström Ōsaka ☃ " + smile)).toBe(
      "Piña P5 \"Best\" 'café' - Ñoño... Ångström Osaka ? ?"
    )
    // A decomposed n + combining tilde is composed first
    expect(toPrintableText("Pin" + String.fromCharCode(0x303) + "a")).toBe("Piña")
    // wpc1252 has the curly quotes and accented capitals CP437 lacks
    expect(toPrintableText("“Ó” €", "wpc1252")).toBe("“Ó” €")
    expect(toPrintableText("“Ó” €")).toBe('"O" EUR')

    const sale = sell([{ productId: "coke", quantity: 1 }])
    sale.items[0] = { ...sale.items[0], product_name: "Piña Café Ñ" }
    const { bytes } = escpos(buildSaleReceipt(sale.transaction, sale.items))
    expect(indexOfBytes(bytes, [0x50, 0x69, 0xa4, 0x61, 0x20, 0x43, 0x61, 0x66, 0x82, 0x20, 0xa5])).toBeGreaterThan(0)

    const latin = renderReceiptEscPos(buildSaleReceipt(sale.transaction, sale.items), { paperWidth: 58, codePage: "wpc1252" })
    expect(indexOfBytes(latin, [0x50, 0x69, 0xf1, 0x61, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x20, 0xd1])).toBeGreaterThan(0)
  })

  it("never lets user text emit printer commands", () => {
    const control = (...codes: number[]) => String.fromCharCode(...codes)
    const sale = sell([{ productId: "coke", quantity: 1 }])
    // ESC @, GS V (cut), ESC p (drawer kick), NUL, tab/newline
    sale.items[0] = { ...sale.items[0], product_name: "Coke" + control(0x1b, 0x40) + control(0x1d, 0x56, 0x00) + control(0x1b, 0x70, 0, 25, 25) + "\tZero\nSugar" + control(0x9b) }
    const { lines } = escpos(buildSaleReceipt(sale.transaction, sale.items, {}, { cashierName: control(0x1b) + "E" + control(1) }))
    expect(lines.find((l) => l.text.startsWith("Coke"))!.text).toBe("Coke?@?V??p??? Zero Sugar?")
    expect(lines.find((l) => l.text.startsWith("Cashier"))!.text).toMatch(/ \?E\?$/)
  })

  it("prints Subtotal - Less VAT - Less Discount = TOTAL on an SC/PWD sale", () => {
    const { transaction, items } = scPwdSale()
    for (const paperWidth of [58, 80] as const) {
      const out = escposText(escpos(buildSaleReceipt(transaction, items, BUSINESS), { paperWidth }).lines)
      const subtotal = amountAfter(out, "Subtotal")
      const lessVat = amountAfter(out, "Less VAT (SC/PWD)")
      const discount = amountAfter(out, "Less Discount")
      expect(lessVat).toBeGreaterThan(0)
      expect(subtotal - lessVat - discount).toBe(amountAfter(out, "TOTAL"))
    }
  })

  it("prints a void slip with a large banner, negatives and the original invoice", () => {
    const sale = scPwdSale()
    const { lines } = escpos(buildVoidSlip(voidOf(sale), sale.transaction, sale.items, BUSINESS, { authorizedByName: "Manager Jose" }))
    expect(lines.find((l) => l.text === "*** VOID ***")).toMatchObject({ bold: true, size: 0x11, align: 1 })
    const out = escposText(lines)
    expect(out).toContain("Orig. Invoice SI-000042")
    expect(out).toContain("Void Ref No CN-000007")
    expect(out).toContain("-3 x 65.00 -195.00")
    expect(amountAfter(out, "TOTAL VOIDED")).toBe(-Math.round(sale.transaction.net_sales * 100))
  })

  it("prints statement lines that add up to the balance due", () => {
    for (const paperWidth of [58, 80] as const) {
      const out = escposText(escpos(statement(), { paperWidth }).lines)
      const amounts = [...out.matchAll(/1 x [\d,]+\.\d{2} (-?[\d,]+\.\d{2})/g)].map((m) => cents(m[1]))
      expect(amounts).toEqual([25000, -10000, 7550, -2500])
      expect(amounts.reduce((a, b) => a + b, 0)).toBe(amountAfter(out, "BALANCE DUE"))
      expect(out).toContain("THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX")
    }
  })
})
