// Parity with POS-bir's printed receipts: for the same records, renderReceiptHtml must show the
// same visible text as POS-bir's electron/receipt-template.js fed the payload its callers build
// (app/pos/page.tsx, lib/printer.ts, components/credit/credit-table.tsx). The template is
// required read-only from a POS-bir checkout (POS_BIR_DIR, default the sibling folder); the suite
// is skipped when that checkout isn't there (e.g. CI).
import { describe, expect, it } from "vitest"
import { lessVatOf, roundMoney } from "../src/ph-tax"
import { buildSale } from "../src/sale"
import { buildVoid } from "../src/void"
import type { SaleRequest } from "../src/sale"
import type { Product, TaxCategory } from "../src/types"
import type { TransactionItemRecord, TransactionRecord } from "../src/model"
import {
  buildPaymentReceipt,
  buildSaleReceipt,
  buildStatementOfAccount,
  buildVoidSlip,
} from "../src/receipt/model"
import type { ReceiptBusiness, StatementLedgerEntry } from "../src/receipt/model"
import { renderReceiptHtml } from "../src/receipt/html"

const node = (globalThis as any).process
const POS_BIR_DIR: string = node.env.POS_BIR_DIR || "/Users/drew/Desktop/projects/POS-bir"
const TEMPLATE = `${POS_BIR_DIR}/electron/receipt-template.js`
const hasPosBir: boolean = node.getBuiltinModule("node:fs").existsSync(TEMPLATE)

// POS-bir formats dates in the machine's local zone; the tablet formats in the store's zone
node.env.TZ = "Asia/Manila"
const posBir: { renderReceiptHtml: (data: unknown, options?: { now?: Date }) => string } | null = hasPosBir
  ? node.getBuiltinModule("node:module").createRequire(TEMPLATE)(TEMPLATE)
  : null

// ---------------------------------------------------------------------------

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

let nextId = 0
const ctx = (now: string) => ({
  storeId: "store-1",
  terminalId: "terminal-1",
  shiftId: "shift-1",
  cashierId: "cashier-1",
  now: new Date(now),
  newId: () => `id-${++nextId}`,
})

function sell(request: SaleRequest) {
  const result = buildSale(request, { products: PRODUCTS }, { ...ctx("2026-10-15T03:59:18.390Z"), nextInvoiceNumber: 42 })
  if (!result.ok) throw new Error(result.message)
  return result
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
// The same header fields as POS-bir payload fields
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

// app/pos/page.tsx: the sale receipt payload
const posBirSalePayload = (t: TransactionRecord, items: TransactionItemRecord[], cashier: string) => ({
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

describe.skipIf(!hasPosBir)("receipts match POS-bir's receipt template", () => {
  const compare = (ours: string, theirs: string, keyFields: string[]) => {
    const a = htmlText(ours)
    const b = htmlText(theirs)
    for (const field of keyFields) {
      expect(a, "tablet").toContain(field)
      expect(b, "POS-bir").toContain(field)
    }
    expect(a).toBe(b)
  }

  it.each([
    [
      "SC/PWD cash sale",
      {
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
      ["SALES INVOICE", "Customer Lolo Ben", "SC/PWD ID OSCA-12345", "Less VAT (SC/PWD)", "Dinorado Rice (kg) 1.25 x 50.00 62.50"],
    ],
    [
      "GCASH sale with wholesale and odd characters",
      {
        lines: [
          { productId: "sardines", quantity: 10 },
          { productId: "odd", quantity: 3 },
        ],
        paymentMethod: "GCASH",
        referenceNumber: "GC-998877",
      },
      ["Ligo Sardines 10 x 22.00 220.00", `Tom & Jerry's <Best> "Snacks" 3 x 12.75 38.25`, "Reference No GC-998877", "Less Discount 0.00"],
    ],
  ] as [string, SaleRequest, string[]][])("%s", (_name, request, keyFields) => {
    const { transaction, items } = sell(request)
    const ours = renderReceiptHtml(buildSaleReceipt(transaction, items, BUSINESS, { cashierName: "Maria" }))
    const theirs = posBir!.renderReceiptHtml(posBirSalePayload(transaction, items, "Maria"))
    compare(ours, theirs, [
      "Aling Nena's Sari-Sari Store",
      "VAT REG TIN: 123-456-789-000",
      "MIN: MIN-0001 S/N: SN-TAB-9 PTU No: PTU-77 Branch 2",
      "Invoice No SI-000042",
      "Date 2026-10-15 11:59:18",
      "Cashier Maria",
      `TOTAL ${transaction.net_sales.toFixed(2)}`,
      "VATable Sales",
      "Thank you! Come again!",
      ...keyFields,
    ])
  })

  it("void slip (lib/printer.ts payload)", () => {
    const sale = sell({
      lines: [{ productId: "coke", quantity: 2 }, { productId: "milk", quantity: 1 }],
      paxCount: 1,
      seniorCount: 1,
      scPwd: { idNumber: "PWD-1", name: "Aling Rosa" },
      paymentMethod: "MAYA",
      referenceNumber: "MY-1",
    })
    const voided = buildVoid(
      { authorizedBy: "manager-1", reason: "Wrong item <scanned>" },
      { original: sale.transaction, items: sale.items, alreadyVoided: false },
      { ...ctx("2026-10-15T05:10:00.000Z"), nextCreditNoteNumber: 7 }
    )
    if (!voided.ok) throw new Error(voided.message)
    const cn = voided.creditNote
    const original = sale.transaction

    const ours = renderReceiptHtml(
      buildVoidSlip(cn, original, sale.items, BUSINESS, { cashierName: "Maria", authorizedByName: "Manager Jose" })
    )
    // printer.ts sends no date, so POS-bir prints the print time: print it right as the void is recorded
    const theirs = posBir!.renderReceiptHtml(
      {
        type: "void",
        ...header,
        invoiceNumber: cn.invoice_number,
        originalInvoiceNumber: original.invoice_number,
        cashier: "Maria",
        reason: cn.void_reason,
        authorizedBy: "Manager Jose",
        items: sale.items.map((item) => ({
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
        paymentMethod: original.payment_method,
      },
      { now: new Date(cn.created_at) }
    )
    compare(ours, theirs, [
      "*** VOID *** VOID SLIP",
      "Void Ref No CN-000007",
      "Orig. Invoice SI-000042",
      "Date 2026-10-15 13:10:00",
      "Authorized By Manager Jose",
      "Reason: Wrong item <scanned>",
      "Coke 1.5L -2 x 65.00 -130.00",
      `TOTAL VOIDED -${original.net_sales.toFixed(2)}`,
      "Orig. Payment MAYA",
      "Come again!",
    ])
  })

  it("statement of account (components/credit/credit-table.tsx payload)", () => {
    const now = new Date("2026-10-15T08:00:00.000Z")
    const entries: StatementLedgerEntry[] = [
      { created_at: "2026-09-30T17:00:00.000Z", entry_type: "CHARGE", amount: 250, invoice_number: "SI-000040" },
      { created_at: "2026-10-05T02:00:00.000Z", entry_type: "PAYMENT", amount: 100, invoice_number: null },
      { created_at: "2026-10-07T03:00:00.000Z", entry_type: "CHARGE", amount: 1075.5, invoice_number: "SI-000051" },
      { created_at: "2026-10-08T03:00:00.000Z", entry_type: "ADJUSTMENT", amount: 25, invoice_number: "CN-000003" },
    ]
    const balance = 1200.5 // the customer's balance is the sum of their entries

    const ours = renderReceiptHtml(buildStatementOfAccount({ full_name: "Juan Dela Cruz" }, entries, BUSINESS, { now }))
    // credit-table prints toLocaleDateString(); spelled out here so the test doesn't depend on the machine locale
    const entryLabel: Record<string, string> = { CHARGE: "Charge", PAYMENT: "Payment", ADJUSTMENT: "Adjustment" }
    const theirs = posBir!.renderReceiptHtml(
      {
        type: "statement",
        ...header,
        customerName: "Juan Dela Cruz",
        invoiceNumber: "SOA-" + now.getTime().toString().slice(-6),
        items: entries.map((e) => ({
          name: `${new Date(e.created_at).toLocaleDateString("en-US", { timeZone: "Asia/Manila" })} - ${entryLabel[e.entry_type]}${e.invoice_number ? ` ${e.invoice_number}` : ""}`,
          quantity: 1,
          lineTotal: e.entry_type === "CHARGE" ? e.amount : -e.amount,
        })),
        total: balance,
      },
      { now }
    )
    compare(ours, theirs, [
      "STATEMENT OF ACCOUNT",
      `SOA No SOA-${now.getTime().toString().slice(-6)}`,
      "Date 2026-10-15 16:00:00",
      "Customer Juan Dela Cruz",
      "10/1/2026 - Charge SI-000040 1 x 250.00 250.00",
      "10/5/2026 - Payment 1 x 100.00 -100.00",
      "BALANCE DUE 1,200.50",
      "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX Come again!",
    ])
  })

  it("payment receipt (receipt-template payload contract)", () => {
    const ours = renderReceiptHtml(
      buildPaymentReceipt(
        { full_name: "Juan Dela Cruz" },
        { created_at: "2026-10-15T06:00:00.000Z", entry_type: "PAYMENT", amount: 1000, running_balance: 1234.56 },
        BUSINESS,
        { receiptNumber: "PR-000007", cashierName: "Maria", paymentMethod: "CASH", amountTendered: 1500, change: 500 }
      )
    )
    const theirs = posBir!.renderReceiptHtml({
      type: "payment",
      ...header,
      invoiceNumber: "PR-000007",
      date: "2026-10-15T06:00:00.000Z",
      cashier: "Maria",
      customerName: "Juan Dela Cruz",
      previousBalance: 2234.56,
      amountPaid: 1000,
      newBalance: 1234.56,
      paymentMethod: "CASH",
      amountTendered: 1500,
      change: 500,
    })
    compare(ours, theirs, [
      "PAYMENT RECEIPT",
      "Receipt No PR-000007",
      "Date 2026-10-15 14:00:00",
      "Previous Balance 2,234.56",
      "AMOUNT PAID 1,000.00",
      "Remaining Balance 1,234.56",
      "Amount Tendered 1,500.00 Change 500.00",
      "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX Thank you! Come again!",
    ])
  })
})
