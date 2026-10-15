// Golden parity: every scenario in fixtures/pc-sale-parity.json was run through POS-bir's real
// POST /api/transactions (see fixtures/README.md). buildSale must produce the same totals, lines,
// stock and credit effects, and refuse the same requests.
import { describe, expect, it } from "vitest"
import {
  buildSale,
  calculateTransactionTotals,
  CreditLedgerEntryRecordSchema,
  StockMovementRecordSchema,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
} from "../src"
import type { CartItem, CreditCustomer, Product, SaleErrorCode } from "../src"
import fixtures from "./fixtures/pc-sale-parity.json"

interface Scenario {
  name: string
  products: Product[]
  customers: CreditCustomer[]
  request: Record<string, any> & { cart: CartItem[] }
  status: number
  response: Record<string, any>
  stockAfter: Record<string, number>
  customersAfter: Record<string, number>
  ledger: { customer_id: string; entry_type: string; amount: number; running_balance: number }[]
}

// POS-bir reports errors as messages; map them to buildSale's codes
const PC_ERRORS: [RegExp, SaleErrorCode][] = [
  [/^Cart is empty/, "EMPTY_CART"],
  [/no longer available/, "PRODUCT_UNAVAILABLE"],
  [/^Invalid quantity/, "INVALID_QUANTITY"],
  [/^Prices changed/, "PRICES_CHANGED"],
  [/^Amount tendered is less/, "TENDER_SHORT"],
  [/^Customer ID is required/, "CUSTOMER_REQUIRED"],
  [/^Customer not found/, "CUSTOMER_NOT_FOUND"],
  [/BLOCKED/, "CUSTOMER_BLOCKED"],
  [/^Credit limit exceeded/, "CREDIT_LIMIT_EXCEEDED"],
  [/^Insufficient stock/, "INSUFFICIENT_STOCK"],
]

const scenarios = (fixtures as unknown as { scenarios: Scenario[] }).scenarios

describe(`buildSale matches POS-bir (${(fixtures as any).generatedFrom})`, () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const req = s.request
    let n = 0
    let seq = 100
    const result = buildSale(
      {
        lines: req.cart.map((c) => ({ productId: c.product.id, quantity: c.quantity })),
        // What POS-bir compares against: the totals of the cart as the client held it
        expectedNetSales: req.cart.length
          ? calculateTransactionTotals(req.cart, req.paxCount || 1, req.seniorCount || 0).netSales
          : undefined,
        paymentMethod: req.payment_method,
        amountTendered: req.amount_tendered,
        referenceNumber: req.reference_number,
        paxCount: req.paxCount,
        seniorCount: req.seniorCount,
        scPwd: req.scPwdData,
      },
      {
        products: new Map(s.products.map((p) => [p.id, p])),
        customer: s.customers.find((c) => c.id === req.reference_number) ?? null,
        openShift: { id: "shift-1", store_id: "store-1", terminal_id: "terminal-1" },
      },
      {
        storeId: "store-1",
        terminalId: "terminal-1",
        cashierId: "user-1",
        now: new Date("2026-10-15T01:00:00.000Z"),
        newId: () => `id-${++n}`,
        nextSeq: () => ++seq,
        nextInvoiceNumber: 1,
      }
    )

    if (s.status !== 201) {
      const code = PC_ERRORS.find(([re]) => re.test(s.response.error))?.[1]
      expect(code, `unmapped POS-bir error: ${s.response.error}`).toBeDefined()
      expect(result).toMatchObject({ ok: false, code })
      return
    }

    if (!result.ok) throw new Error(`expected a sale, got ${result.code}: ${result.message}`)
    const pc = s.response
    const { transaction: tx } = result
    for (const field of [
      "invoice_number", "gross_sales", "vatable_sales", "vat_amount", "vat_exempt_sales", "zero_rated_sales",
      "total_discount", "net_sales", "pax_count", "senior_count", "sc_pwd_id", "sc_pwd_name",
      "payment_method", "amount_tendered", "change_amount", "reference_number",
    ] as const) {
      expect(tx[field], field).toEqual(pc[field])
    }
    expect(tx).toMatchObject({
      transaction_type: "SALE",
      status: "PAID",
      shift_id: "shift-1",
      cashier_id: "user-1",
      store_id: "store-1",
      terminal_id: "terminal-1",
    })

    // Linkage: every record belongs to this sale, terminal and shift, in creation order
    const products = new Map(s.products.map((p) => [p.id, p]))
    for (const i of result.items) {
      expect(i).toMatchObject({ transaction_id: tx.id, terminal_id: "terminal-1", unit_type: products.get(i.product_id)!.unit_type })
    }
    for (const m of result.stockMovements) expect(m).toMatchObject({ ref_id: tx.id, reason: "SALE", terminal_id: "terminal-1" })
    if (result.ledgerEntry) {
      expect(result.ledgerEntry).toMatchObject({ transaction_id: tx.id, shift_id: "shift-1", customer_id: req.reference_number })
    }
    const all = [tx, ...result.items, ...result.stockMovements, ...(result.ledgerEntry ? [result.ledgerEntry] : [])]
    expect(all.map((r) => r.device_seq)).toEqual(all.map((_, k) => 101 + k))
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
    expect(result.warnings).toEqual([])

    // Every record is valid for sync
    TransactionRecordSchema.parse(tx)
    for (const i of result.items) TransactionItemRecordSchema.parse(i)
    for (const m of result.stockMovements) StockMovementRecordSchema.parse(m)
    if (result.ledgerEntry) CreditLedgerEntryRecordSchema.parse(result.ledgerEntry)

    expect(
      result.items.map((i) => [i.product_id, i.product_name, i.quantity_sold, i.price_at_sale, i.cost_at_sale, i.tax_category])
    ).toEqual(pc.items.map((i: any) => [i.product_id, i.name, i.quantity_sold, i.price_at_sale, i.cost_at_sale, i.tax_category]))

    // Stock: POS-bir's stock after the sale = stock before + this sale's movements
    const stock = Object.fromEntries(s.products.map((p) => [p.id, p.stock_level]))
    for (const m of result.stockMovements) stock[m.product_id] = (stock[m.product_id] ?? 0) + m.quantity_delta
    for (const [id, level] of Object.entries(s.stockAfter)) expect(stock[id], `stock ${id}`).toBeCloseTo(level, 9)

    // Store credit: same CHARGE entry and resulting balance
    expect(result.ledgerEntry ? [result.ledgerEntry] : []).toEqual(
      s.ledger.map((l) => expect.objectContaining({ customer_id: l.customer_id, entry_type: l.entry_type, amount: l.amount, running_balance: l.running_balance }))
    )
    if (result.customerBalanceAfter !== null) {
      expect(result.customerBalanceAfter).toBe(s.customersAfter[req.reference_number])
    }
  })
})
