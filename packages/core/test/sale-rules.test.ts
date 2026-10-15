// buildSale rules beyond the POS-bir parity scenarios
import { describe, expect, it } from "vitest"
import {
  buildSale,
  calculateTransactionTotals,
  CreditLedgerEntryRecordSchema,
  StockMovementRecordSchema,
  sumQuantities,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
} from "../src"
import type { Product, SaleContext, SaleData } from "../src"

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "soap",
  name: "Soap",
  barcode: null,
  selling_price: 25,
  cost_price: 18,
  stock_level: 10,
  unit_type: "QUANTITY",
  low_stock_threshold: 0,
  notify_low_stock: false,
  category_id: null,
  tax_category: "VATABLE",
  supplier_type: "WHOLESALER",
  is_promo: false,
  promo_price: null,
  pos_id: "x",
  is_synced: false,
  ...overrides,
})

const ctx = (overrides: Partial<SaleContext> = {}): SaleContext => {
  let n = 0
  let seq = 0
  return {
    storeId: "store-1",
    terminalId: "terminal-1",
    cashierId: "user-1",
    now: new Date("2026-10-15T01:00:00.000Z"),
    newId: () => `id-${++n}`,
    nextSeq: () => ++seq,
    nextInvoiceNumber: 41,
    ...overrides,
  }
}

const openShift = { id: "shift-1", store_id: "store-1", terminal_id: "terminal-1" }
const data = (list: Product[], extra: Partial<SaleData> = {}): SaleData => ({
  products: new Map(list.map((p) => [p.id, p])),
  openShift,
  ...extra,
})
const products = (...list: Product[]) => new Map(list.map((p) => [p.id, p]))

describe("buildSale rules", () => {
  it.each([
    [1, 2],
    [2, 5],
    [1.5, 1],
    [-1, 0],
    [3, -1],
    [2, 0.5],
  ])("refuses pax=%s seniors=%s instead of producing corrupt BIR totals", (paxCount, seniorCount) => {
    const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }], paxCount, seniorCount }, data([product()]), ctx())
    expect(result).toMatchObject({ ok: false, code: "INVALID_PAX" })
  })

  it("treats a missing or 0 pax count as 1, like POS-bir", () => {
    for (const paxCount of [undefined, 0]) {
      const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }], paxCount }, data([product()]), ctx())
      expect(result).toMatchObject({ ok: true, transaction: { pax_count: 1, senior_count: 0 } })
    }
  })

  it("refuses an unknown payment method", () => {
    const result = buildSale(
      { lines: [{ productId: "soap", quantity: 1 }], paymentMethod: "BITCOIN" as never },
      data([product()]),
      ctx()
    )
    expect(result).toMatchObject({ ok: false, code: "INVALID_PAYMENT_METHOD" })
  })

  it("issues the terminal's next SI number and returns the one after", () => {
    const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }] }, data([product()]), ctx())
    expect(result).toMatchObject({ ok: true, transaction: { invoice_number: "SI-000041" }, nextInvoiceNumber: 42 })
  })

  it("checks stock across repeated lines of the same product", () => {
    const lines = [
      { productId: "soap", quantity: 6 },
      { productId: "soap", quantity: 5 },
    ]
    expect(buildSale({ lines }, data([product({ stock_level: 10 })]), ctx())).toMatchObject({
      ok: false,
      code: "INSUFFICIENT_STOCK",
    })
    expect(buildSale({ lines }, data([product({ stock_level: 11 })]), ctx())).toMatchObject({ ok: true })
  })

  it("detects a one-centavo price change against the total the cashier was shown", () => {
    const shown = calculateTransactionTotals([{ product: product({ selling_price: 25 }), quantity: 2 }], 1, 0).netSales
    const now = products(product({ selling_price: 25.01 }))
    expect(buildSale({ lines: [{ productId: "soap", quantity: 2 }], expectedNetSales: shown }, { products: now, openShift }, ctx())).toMatchObject({
      ok: false,
      code: "PRICES_CHANGED",
    })
  })

  it("is deterministic: the same input and context give the same records", () => {
    const run = () => buildSale({ lines: [{ productId: "soap", quantity: 3 }], amountTendered: 100 }, data([product()]), ctx())
    expect(run()).toEqual(run())
  })

  it("does not touch the input product rows", () => {
    const p = product()
    const snapshot = JSON.parse(JSON.stringify(p))
    buildSale({ lines: [{ productId: "soap", quantity: 3 }] }, data([p]), ctx())
    expect(p).toEqual(snapshot)
  })

  it("needs an open shift on this terminal", () => {
    for (const shift of [null, { ...openShift, terminal_id: "terminal-2" }, { ...openShift, store_id: "store-2" }]) {
      expect(buildSale({ lines: [{ productId: "soap", quantity: 1 }] }, data([product()], { openShift: shift }), ctx())).toMatchObject({
        ok: false,
        code: "NO_OPEN_SHIFT",
      })
    }
  })

  it("needs the SC/PWD ID for a senior/PWD discount", () => {
    const req = { lines: [{ productId: "soap", quantity: 1 }], paxCount: 1, seniorCount: 1 }
    for (const scPwd of [undefined, { idNumber: "  ", name: "Lola" }]) {
      expect(buildSale({ ...req, scPwd }, data([product()]), ctx())).toMatchObject({ ok: false, code: "SC_PWD_ID_REQUIRED" })
    }
    expect(buildSale({ ...req, scPwd: { idNumber: "SC-1" } }, data([product()]), ctx())).toMatchObject({ ok: true })
  })

  it("sells the last of a weighed product exactly (no float leftovers)", () => {
    const rice = product({ id: "rice", unit_type: "WEIGHT", stock_level: sumQuantities(0.7, -0.4) })
    expect(0.7 - 0.4).not.toBe(0.3) // the float trap this avoids
    expect(buildSale({ lines: [{ productId: "rice", quantity: 0.3 }] }, data([rice]), ctx())).toMatchObject({ ok: true })
    const stock3 = product({ id: "rice", unit_type: "WEIGHT", stock_level: 0.3 })
    const lines = [
      { productId: "rice", quantity: 0.1 },
      { productId: "rice", quantity: 0.2 },
    ]
    expect(buildSale({ lines }, data([stock3]), ctx())).toMatchObject({ ok: true })
  })

  it("accepts weights in grams only (at most 3 decimals)", () => {
    const rice = product({ id: "rice", unit_type: "WEIGHT", stock_level: 100 })
    expect(buildSale({ lines: [{ productId: "rice", quantity: 1.2345 }] }, data([rice]), ctx())).toMatchObject({
      ok: false,
      code: "INVALID_QUANTITY",
    })
    expect(buildSale({ lines: [{ productId: "rice", quantity: 1.234 }] }, data([rice]), ctx())).toMatchObject({ ok: true })
  })

  it("can sell past local stock with a warning when the store allows it", () => {
    const req = { lines: [{ productId: "soap", quantity: 3 }] }
    const low = [product({ stock_level: 2 })]
    expect(buildSale(req, data(low), ctx())).toMatchObject({ ok: false, code: "INSUFFICIENT_STOCK" })
    expect(buildSale(req, data(low, { stockPolicy: "warn" }), ctx())).toMatchObject({
      ok: true,
      warnings: [{ code: "NEGATIVE_STOCK", productId: "soap", stockAfter: -1 }],
    })
  })

  describe("store credit", () => {
    const customer = { id: "rosa", credit_limit: 100, current_debt_balance: 50, credit_status: "ACTIVE" as const }
    const req = (quantity: number) => ({ lines: [{ productId: "soap", quantity }], paymentMethod: "STORE_CREDIT" as const, referenceNumber: "rosa" })

    it("allows a charge that lands exactly on the limit, and refuses one centavo more", () => {
      expect(buildSale(req(2), data([product()], { customer }), ctx())).toMatchObject({ ok: true, customerBalanceAfter: 100 })
      const over = { ...customer, current_debt_balance: 50.01 }
      expect(buildSale(req(2), data([product()], { customer: over }), ctx())).toMatchObject({ ok: false, code: "CREDIT_LIMIT_EXCEEDED" })
    })

    it("follows the store's offline credit mode", () => {
      const offline = (mode: "A" | "B" | "C", extra = {}) => data([product()], { customer, creditPolicy: { mode, offline: true, ...extra } })
      expect(buildSale(req(1), offline("A"), ctx())).toMatchObject({ ok: true })
      expect(buildSale(req(1), offline("B"), ctx())).toMatchObject({ ok: false, code: "STORE_CREDIT_OFFLINE" })
      expect(buildSale(req(1), data([product()], { customer, creditPolicy: { mode: "B", offline: false } }), ctx())).toMatchObject({ ok: true })
      expect(buildSale(req(1), offline("C", { offlineCapPerCustomer: 30, chargedSinceSync: 5 }), ctx())).toMatchObject({ ok: true })
      expect(buildSale(req(1), offline("C", { offlineCapPerCustomer: 30, chargedSinceSync: 5.01 }), ctx())).toMatchObject({
        ok: false,
        code: "OFFLINE_CREDIT_CAP_EXCEEDED",
      })
    })

    it("emits records that all pass their sync schemas", () => {
      const result = buildSale(req(2), data([product()], { customer }), ctx())
      if (!result.ok) throw new Error(result.code)
      TransactionRecordSchema.parse(result.transaction)
      result.items.forEach((i) => TransactionItemRecordSchema.parse(i))
      result.stockMovements.forEach((m) => StockMovementRecordSchema.parse(m))
      CreditLedgerEntryRecordSchema.parse(result.ledgerEntry)
    })
  })
})
