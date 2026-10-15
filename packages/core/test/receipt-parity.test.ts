// Parity with POS-bir's printed receipts. fixtures/pc-receipt-parity.json records, for each
// scenario, the core records, the payload POS-bir's callers build from them (app/pos/page.tsx,
// lib/printer.ts, components/credit/credit-table.tsx) and the HTML POS-bir's
// electron/receipt-template.js rendered for it. renderReceiptHtml must show the same visible text.
//
// - Always runs: compares against the recorded HTML.
// - With a POS-bir checkout (POS_BIR_DIR, default the sibling folder): also compares against the
//   live template.
// - UPDATE_RECEIPT_FIXTURE=1 (with a checkout) rewrites the fixture; see fixtures/README.md.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { calculateTransactionTotals, getActivePrice, lessVatOf, roundMoney } from "../src/ph-tax"
import {
  CreditLedgerEntryRecordSchema,
  CreditNoteRecordSchema,
  SaleRecordSchema,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
} from "../src/model"
import type { CreditLedgerEntryRecord, CreditNoteRecord, PaymentMethod, SaleRecord, TransactionItemRecord } from "../src/model"
import type { Product, TaxCategory } from "../src/types"
import {
  buildPaymentReceipt,
  buildSaleReceipt,
  buildStatementOfAccount,
  buildVoidSlip,
  formatReceiptItemDetail,
  formatReceiptMoney,
} from "../src/receipt/model"
import type { ReceiptBusiness, ReceiptDocument } from "../src/receipt/model"
import { renderReceiptHtml } from "../src/receipt/html"
import fixtureJson from "./fixtures/pc-receipt-parity.json"

// ---------------------------------------------------------------------------
// Fixture format

type Kind = "sale" | "void" | "statement" | "payment"
interface Scenario {
  name: string
  kind: Kind
  /** Arguments for our builder (records as stored on the terminal) */
  input: Record<string, any>
  /** What POS-bir's caller sends to printReceipt for the same records */
  posBirPayload: Record<string, unknown>
  /** POS-bir's fallback print time (its void slip and statement callers send no date) */
  posBirNow: string | null
  /** POS-bir's renderReceiptHtml output */
  html: string
  /** Text both receipts must show */
  keyFields: string[]
}
interface Fixture {
  generatedFrom: string
  template: string
  templateSha256: string
  timeZone: string
  scenarios: Scenario[]
}
const fixture = fixtureJson as unknown as Fixture

// ---------------------------------------------------------------------------
// Our side: build the document from the recorded records

function buildDoc(s: Scenario): ReceiptDocument {
  const i = s.input
  const items = () => (i.items as unknown[]).map((x) => TransactionItemRecordSchema.parse(x))
  switch (s.kind) {
    case "sale":
      return buildSaleReceipt(TransactionRecordSchema.parse(i.transaction), items(), i.business, i.options)
    case "void":
      return buildVoidSlip(
        TransactionRecordSchema.parse(i.creditNote),
        TransactionRecordSchema.parse(i.originalSale),
        items(),
        i.business,
        i.options
      )
    case "statement":
      for (const e of i.entries) CreditLedgerEntryRecordSchema.parse(e)
      return buildStatementOfAccount(i.customer, i.entries, i.business, { ...i.options, now: new Date(i.options.now) })
    case "payment":
      return buildPaymentReceipt(i.customer, CreditLedgerEntryRecordSchema.parse(i.entry), i.business, i.options)
  }
}

// Intended difference: weighed quantities show their unit ("1.25 kg x 50.00"); POS-bir printed
// "1.25 x 50.00". Everything else must match, so compare with the unit taken off.
const withoutUnits = (doc: ReceiptDocument): ReceiptDocument => ({ ...doc, items: doc.items.map((i) => ({ ...i, unit: null })) })

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

const cases = fixture.scenarios.map((s) => [s.name, s] as const)

describe(`receipts match POS-bir's recorded receipts (${fixture.generatedFrom})`, () => {
  it("has a recorded scenario for every receipt kind", () => {
    expect(new Set(fixture.scenarios.map((s) => s.kind))).toEqual(new Set(["sale", "void", "statement", "payment"]))
  })

  it.each(cases)("%s", (_name, s) => {
    const doc = buildDoc(s)
    const recorded = htmlText(s.html)
    for (const field of s.keyFields) expect(recorded, "POS-bir").toContain(field)
    expect(htmlText(renderReceiptHtml(withoutUnits(doc)))).toBe(recorded)

    // ...and the one intended difference
    const ours = htmlText(renderReceiptHtml(doc))
    for (const item of doc.items.filter((i) => i.unit)) {
      expect(ours).toContain(`${item.name} ${formatReceiptItemDetail(item)} ${formatReceiptMoney(item.lineTotal)}`)
      expect(formatReceiptItemDetail(item)).toMatch(/ kg x /)
    }
  })
})

// ---------------------------------------------------------------------------
// Live POS-bir checkout (optional)

const node = (globalThis as any).process
const fs = node.getBuiltinModule("node:fs")
const POS_BIR_DIR: string = node.env.POS_BIR_DIR || "/Users/drew/Desktop/projects/POS-bir"
const TEMPLATE = `${POS_BIR_DIR}/electron/receipt-template.js`
const hasPosBir: boolean = fs.existsSync(TEMPLATE)
type PosBirTemplate = { renderReceiptHtml: (data: unknown, options?: { now?: Date }) => string }
const loadPosBir = (): PosBirTemplate => node.getBuiltinModule("node:module").createRequire(TEMPLATE)(TEMPLATE)
const posBirOptions = (now: string | null) => (now ? { now: new Date(now) } : undefined)

// POS-bir formats dates in the machine's local zone; the fixture was recorded in the store's zone
let savedTz: string | undefined
const useStoreZone = () => {
  beforeAll(() => {
    savedTz = node.env.TZ
    node.env.TZ = fixture.timeZone || "Asia/Manila"
  })
  afterAll(() => {
    if (savedTz === undefined) delete node.env.TZ
    else node.env.TZ = savedTz
  })
}

describe.skipIf(!hasPosBir)("receipts match the live POS-bir template", () => {
  useStoreZone()
  it.each(cases)("%s", (_name, s) => {
    const live = loadPosBir().renderReceiptHtml(s.posBirPayload, posBirOptions(s.posBirNow))
    expect(htmlText(renderReceiptHtml(withoutUnits(buildDoc(s))))).toBe(htmlText(live))
  })
})

// ---------------------------------------------------------------------------
// Fixture generator: UPDATE_RECEIPT_FIXTURE=1 with a POS-bir checkout

const product = (id: string, name: string, price: number, tax: TaxCategory = "VATABLE", extra: Partial<Product> = {}): Product => ({
  id,
  name,
  barcode: null,
  selling_price: price,
  cost_price: 1,
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
    product("milk", "Bear Brand Milk 300g", 85, "VAT_EXEMPT"),
    product("sardines", "Ligo Sardines", 24, "VATABLE", { wholesale_price: 22, wholesale_threshold: 10 }),
    product("eggs", "Fresh Eggs (tray)", 230, "ZERO_RATED"),
    product("odd", `Tom & Jerry's <Best> "Snacks"`, 12.75),
  ].map((p) => [p.id, p])
)

let seq = 0
const base = (at: string) => ({ id: `rec-${++seq}`, store_id: "store-1", terminal_id: "terminal-1", device_seq: seq, created_at: at })

interface SaleSpec {
  lines: { productId: string; quantity: number }[]
  invoiceNumber: string
  at: string
  paymentMethod?: PaymentMethod
  amountTendered?: number
  referenceNumber?: string
  paxCount?: number
  seniorCount?: number
  scPwd?: { idNumber: string; name: string }
}

/** A sale priced and totalled with the core tax rules (as buildSale does), checked against the schemas */
function sale(spec: SaleSpec): { transaction: SaleRecord; items: TransactionItemRecord[] } {
  const cart = spec.lines.map(({ productId, quantity }) => {
    const p = PRODUCTS.get(productId)!
    return { product: p, quantity, active_price: getActivePrice(p, quantity) }
  })
  const pax = spec.paxCount ?? 1
  const seniors = spec.seniorCount ?? 0
  const t = calculateTransactionTotals(cart, pax, seniors)
  const tendered = spec.amountTendered ?? null
  const transaction = SaleRecordSchema.parse({
    ...base(spec.at),
    shift_id: "shift-1",
    cashier_id: "cashier-1",
    invoice_number: spec.invoiceNumber,
    transaction_type: "SALE",
    status: "PAID",
    original_transaction_id: null,
    void_reason: null,
    authorized_by: null,
    gross_sales: t.grossSales,
    vatable_sales: t.vatableSales,
    vat_amount: t.vatAmount,
    vat_exempt_sales: t.vatExemptSales,
    zero_rated_sales: t.zeroRatedSales,
    total_discount: t.totalDiscount,
    net_sales: t.netSales,
    pax_count: pax,
    senior_count: seniors,
    sc_pwd_id: spec.scPwd?.idNumber ?? null,
    sc_pwd_name: spec.scPwd?.name ?? null,
    payment_method: spec.paymentMethod ?? "CASH",
    amount_tendered: tendered,
    change_amount: tendered === null ? 0 : roundMoney(tendered - t.netSales),
    reference_number: spec.referenceNumber ?? null,
  })
  TransactionRecordSchema.parse(transaction)
  const items = cart.map((c) =>
    TransactionItemRecordSchema.parse({
      ...base(spec.at),
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
function creditNote(t: SaleRecord, at: string, number: string, reason: string | null): CreditNoteRecord {
  const cn = CreditNoteRecordSchema.parse({
    ...t,
    ...base(at),
    invoice_number: number,
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
  TransactionRecordSchema.parse(cn)
  return cn
}

function ledgerEntry(fields: Partial<CreditLedgerEntryRecord> & Pick<CreditLedgerEntryRecord, "created_at" | "entry_type" | "amount" | "running_balance">) {
  return CreditLedgerEntryRecordSchema.parse({
    ...base(fields.created_at),
    customer_id: "cust-1",
    transaction_id: null,
    shift_id: "shift-1",
    notes: null,
    payment_method: null,
    reference_number: null,
    ...fields,
  })
}

const BUSINESS: ReceiptBusiness = {
  businessName: "Aling Nena's Sari-Sari Store",
  address: "123 Rizal Ave, Brgy. San Jose, Quezon City",
  tin: "123-456-789-000",
  min: "MIN-0001",
  serialNumber: "SN-TAB-9",
  ptuNumber: "PTU-77",
  headerLines: ["Branch 2"],
  footerLines: ["Come again!"],
}
const header = {
  businessName: BUSINESS.businessName,
  address: BUSINESS.address,
  tin: BUSINESS.tin,
  min: BUSINESS.min,
  serialNumber: BUSINESS.serialNumber,
  ptuNumber: BUSINESS.ptuNumber,
  headerLines: BUSINESS.headerLines,
  footerLines: BUSINESS.footerLines,
}

// app/pos/page.tsx
const posBirSale = (t: SaleRecord, items: TransactionItemRecord[], cashier: string) => ({
  type: "sale",
  ...header,
  invoiceNumber: t.invoice_number,
  date: t.created_at,
  cashier,
  customerName: t.sc_pwd_name || undefined,
  scPwdId: t.sc_pwd_id || undefined,
  items: items.map((i) => ({
    name: i.product_name,
    quantity: i.quantity_sold,
    unitPrice: i.price_at_sale,
    lineTotal: roundMoney(i.price_at_sale * i.quantity_sold),
  })),
  subtotal: t.gross_sales,
  lessVat: lessVatOf(t),
  discount: t.total_discount,
  vatableSales: t.vatable_sales,
  vatAmount: t.vat_amount,
  vatExemptSales: t.vat_exempt_sales,
  zeroRatedSales: t.zero_rated_sales,
  total: t.net_sales,
  paymentMethod: t.payment_method,
  referenceNumber: t.reference_number || undefined,
  amountTendered: t.amount_tendered ?? undefined,
  change: t.change_amount ?? undefined,
})

interface Definition {
  name: string
  kind: Kind
  make: () => { input: Record<string, any>; posBirPayload: Record<string, unknown>; posBirNow?: string }
  keyFields: string[]
}

const SALE_FIELDS = [
  "Aling Nena's Sari-Sari Store",
  "VAT REG TIN: 123-456-789-000",
  "MIN: MIN-0001 S/N: SN-TAB-9 PTU No: PTU-77 Branch 2",
  "Date 2026-10-15 11:59:18",
  "Cashier Maria",
  "VATable Sales",
  "Thank you! Come again!",
]

function saleDefinition(name: string, spec: Omit<SaleSpec, "at">, keyFields: string[]): Definition {
  return {
    name,
    kind: "sale",
    make: () => {
      const { transaction, items } = sale({ ...spec, at: "2026-10-15T03:59:18.390Z" })
      return {
        input: { transaction, items, business: BUSINESS, options: { cashierName: "Maria" } },
        posBirPayload: posBirSale(transaction, items, "Maria"),
      }
    },
    keyFields: [...SALE_FIELDS, `Invoice No ${spec.invoiceNumber}`, ...keyFields],
  }
}

const DEFINITIONS: Definition[] = [
  saleDefinition(
    "SC/PWD cash sale with a weighed line",
    {
      invoiceNumber: "SI-000042",
      lines: [
        { productId: "coke", quantity: 3 },
        { productId: "milk", quantity: 2 },
        { productId: "eggs", quantity: 1 },
        { productId: "rice", quantity: 1.25 },
      ],
      paxCount: 2,
      seniorCount: 1,
      scPwd: { idNumber: "OSCA-12345", name: "Lolo Ben" },
      amountTendered: 1000,
    },
    [
      "SALES INVOICE",
      "Customer Lolo Ben",
      "SC/PWD ID OSCA-12345",
      "Subtotal 657.50 Less VAT (SC/PWD) 13.79 Less Discount 62.99 TOTAL 580.72",
      "Dinorado Rice (kg) 1.25 x 50.00 62.50",
      "Amount Tendered 1,000.00 Change 419.28",
    ]
  ),
  saleDefinition(
    "GCASH sale with a wholesale line and HTML-significant characters",
    {
      invoiceNumber: "SI-000043",
      lines: [
        { productId: "sardines", quantity: 10 },
        { productId: "odd", quantity: 3 },
      ],
      paymentMethod: "GCASH",
      referenceNumber: "GC-998877",
    },
    ["Ligo Sardines 10 x 22.00 220.00", `Tom & Jerry's <Best> "Snacks" 3 x 12.75 38.25`, "Reference No GC-998877", "Less Discount 0.00"]
  ),
  saleDefinition(
    "store-credit sale without a customer name (the id prints as the reference)",
    {
      invoiceNumber: "SI-000044",
      lines: [{ productId: "coke", quantity: 2 }],
      paymentMethod: "STORE_CREDIT",
      referenceNumber: "cust-1",
    },
    ["Payment STORE_CREDIT Reference No cust-1", "TOTAL 130.00"]
  ),
  {
    name: "void slip for an SC/PWD MAYA sale (lib/printer.ts payload)",
    kind: "void",
    make: () => {
      const original = sale({
        invoiceNumber: "SI-000045",
        at: "2026-10-15T03:59:18.390Z",
        lines: [
          { productId: "coke", quantity: 2 },
          { productId: "milk", quantity: 1 },
          { productId: "rice", quantity: 0.75 },
        ],
        seniorCount: 1,
        scPwd: { idNumber: "PWD-1", name: "Aling Rosa" },
        paymentMethod: "MAYA",
        referenceNumber: "MY-1",
      })
      const cn = creditNote(original.transaction, "2026-10-15T05:10:00.000Z", "CN-000007", "Wrong item <scanned>")
      return {
        input: {
          creditNote: cn,
          originalSale: original.transaction,
          items: original.items,
          business: BUSINESS,
          options: { cashierName: "Maria", authorizedByName: "Manager Jose" },
        },
        posBirPayload: {
          type: "void",
          ...header,
          invoiceNumber: cn.invoice_number,
          originalInvoiceNumber: original.transaction.invoice_number,
          cashier: "Maria",
          reason: cn.void_reason,
          authorizedBy: "Manager Jose",
          items: original.items.map((item) => ({
            name: item.product_name || "Item",
            quantity: -item.quantity_sold,
            unitPrice: item.price_at_sale,
            lineTotal: -(item.quantity_sold * item.price_at_sale),
          })),
          lessVat: lessVatOf(cn),
          discount: Number(cn.total_discount) || undefined,
          vatableSales: Number(cn.vatable_sales),
          vatAmount: Number(cn.vat_amount),
          vatExemptSales: Number(cn.vat_exempt_sales),
          zeroRatedSales: Number(cn.zero_rated_sales),
          total: Number(cn.net_sales),
          paymentMethod: original.transaction.payment_method,
        },
        // printer.ts sends no date: POS-bir prints the print time, i.e. right as the void is recorded
        posBirNow: cn.created_at,
      }
    },
    keyFields: [
      "*** VOID *** VOID SLIP",
      "Void Ref No CN-000007",
      "Orig. Invoice SI-000045",
      "Date 2026-10-15 13:10:00",
      "Authorized By Manager Jose",
      "Reason: Wrong item <scanned>",
      "Coke 1.5L -2 x 65.00 -130.00",
      "Dinorado Rice (kg) -0.75 x 50.00 -37.50",
      "TOTAL VOIDED",
      "Orig. Payment MAYA",
      "Come again!",
    ],
  },
  {
    name: "statement of account (components/credit/credit-table.tsx payload)",
    kind: "statement",
    make: () => {
      const now = "2026-10-15T08:00:00.000Z"
      const entries = [
        { ...ledgerEntry({ created_at: "2026-09-30T17:00:00.000Z", entry_type: "CHARGE", amount: 250, running_balance: 250, transaction_id: "sale-40" }), invoice_number: "SI-000040" },
        { ...ledgerEntry({ created_at: "2026-10-05T02:00:00.000Z", entry_type: "PAYMENT", amount: 100, running_balance: 150, payment_method: "CASH" }), invoice_number: null },
        { ...ledgerEntry({ created_at: "2026-10-07T03:00:00.000Z", entry_type: "CHARGE", amount: 1075.5, running_balance: 1225.5, transaction_id: "sale-51" }), invoice_number: "SI-000051" },
        { ...ledgerEntry({ created_at: "2026-10-08T03:00:00.000Z", entry_type: "ADJUSTMENT", amount: 25, running_balance: 1200.5, transaction_id: "cn-3" }), invoice_number: "CN-000003" },
      ]
      const entryLabel: Record<string, string> = { CHARGE: "Charge", PAYMENT: "Payment", ADJUSTMENT: "Adjustment" }
      return {
        input: {
          customer: { id: "cust-1", full_name: "Juan Dela Cruz" },
          entries,
          business: BUSINESS,
          options: { now, statementNumber: "SOA-000123" },
        },
        posBirPayload: {
          type: "statement",
          ...header,
          customerName: "Juan Dela Cruz",
          invoiceNumber: "SOA-000123",
          // credit-table prints toLocaleDateString(); spelled out so the recording doesn't depend on the machine locale
          items: entries.map((e) => ({
            name: `${new Date(e.created_at).toLocaleDateString("en-US", { timeZone: "Asia/Manila" })} - ${entryLabel[e.entry_type]}${e.invoice_number ? ` ${e.invoice_number}` : ""}`,
            quantity: 1,
            lineTotal: e.entry_type === "CHARGE" ? e.amount : -e.amount,
          })),
          total: 1200.5, // the customer's balance: the sum of their entries
        },
        posBirNow: now,
      }
    },
    keyFields: [
      "STATEMENT OF ACCOUNT",
      "SOA No SOA-000123",
      "Date 2026-10-15 16:00:00",
      "Customer Juan Dela Cruz",
      "10/1/2026 - Charge SI-000040 1 x 250.00 250.00",
      "10/5/2026 - Payment 1 x 100.00 -100.00",
      "BALANCE DUE 1,200.50",
      "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX Come again!",
    ],
  },
  {
    name: "payment receipt (receipt-template payload contract)",
    kind: "payment",
    make: () => {
      const entry = ledgerEntry({
        created_at: "2026-10-15T06:00:00.000Z",
        entry_type: "PAYMENT",
        amount: 1000,
        running_balance: 1234.56,
        payment_method: "GCASH",
        reference_number: "GC-5566",
      })
      return {
        // The payment method and reference come from the entry itself
        input: {
          customer: { id: "cust-1", full_name: "Juan Dela Cruz" },
          entry,
          business: BUSINESS,
          options: { receiptNumber: "PR-000007", cashierName: "Maria" },
        },
        posBirPayload: {
          type: "payment",
          ...header,
          invoiceNumber: "PR-000007",
          date: entry.created_at,
          cashier: "Maria",
          customerName: "Juan Dela Cruz",
          previousBalance: 2234.56,
          amountPaid: 1000,
          newBalance: 1234.56,
          paymentMethod: "GCASH",
          referenceNumber: "GC-5566",
        },
      }
    },
    keyFields: [
      "PAYMENT RECEIPT",
      "Receipt No PR-000007",
      "Date 2026-10-15 14:00:00",
      "Previous Balance 2,234.56",
      "AMOUNT PAID 1,000.00",
      "Remaining Balance 1,234.56",
      "Payment GCASH Reference No GC-5566",
      "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX Thank you! Come again!",
    ],
  },
]

/** The checkout's commit, read from .git without running git */
function gitHead(dir: string): string {
  const head = fs.readFileSync(`${dir}/.git/HEAD`, "utf8").trim()
  if (!head.startsWith("ref: ")) return head
  const ref = head.slice(5)
  if (fs.existsSync(`${dir}/.git/${ref}`)) return fs.readFileSync(`${dir}/.git/${ref}`, "utf8").trim()
  const packed: string = fs.existsSync(`${dir}/.git/packed-refs`) ? fs.readFileSync(`${dir}/.git/packed-refs`, "utf8") : ""
  return packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? "unknown"
}

describe.skipIf(!hasPosBir || !node.env.UPDATE_RECEIPT_FIXTURE)("regenerate fixtures/pc-receipt-parity.json", () => {
  useStoreZone()
  it("records POS-bir's receipt template output", () => {
    const posBir = loadPosBir()
    const scenarios = DEFINITIONS.map((d): Scenario => {
      const { input, posBirPayload, posBirNow = null } = d.make()
      // Round-trip first, so the recording is made from exactly what the fixture stores
      const payload = JSON.parse(JSON.stringify(posBirPayload))
      return {
        name: d.name,
        kind: d.kind,
        input,
        posBirPayload: payload,
        posBirNow,
        html: posBir.renderReceiptHtml(payload, posBirOptions(posBirNow)),
        keyFields: d.keyFields,
      }
    })
    for (const s of scenarios) for (const field of s.keyFields) expect(htmlText(s.html), s.name).toContain(field)
    const out: Fixture = {
      generatedFrom: `POS-bir@${gitHead(POS_BIR_DIR)}`,
      template: "electron/receipt-template.js",
      templateSha256: node.getBuiltinModule("node:crypto").createHash("sha256").update(fs.readFileSync(TEMPLATE)).digest("hex"),
      timeZone: "Asia/Manila",
      scenarios,
    }
    const fixtureUrl = new (globalThis as any).URL("./fixtures/pc-receipt-parity.json", (import.meta as any).url)
    fs.writeFileSync(fixtureUrl, JSON.stringify(out, null, 2) + "\n")
  })
})
