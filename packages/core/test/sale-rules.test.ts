// buildSale rules beyond the POS-bir parity scenarios
import { describe, expect, it } from "vitest"
import { buildSale, calculateTransactionTotals } from "../src"
import type { Product, SaleContext } from "../src"

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
  return {
    storeId: "store-1",
    terminalId: "terminal-1",
    shiftId: "shift-1",
    cashierId: "user-1",
    now: new Date("2026-10-15T01:00:00.000Z"),
    newId: () => `id-${++n}`,
    nextInvoiceNumber: 41,
    ...overrides,
  }
}

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
    const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }], paxCount, seniorCount }, { products: products(product()) }, ctx())
    expect(result).toMatchObject({ ok: false, code: "INVALID_PAX" })
  })

  it("treats a missing or 0 pax count as 1, like POS-bir", () => {
    for (const paxCount of [undefined, 0]) {
      const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }], paxCount }, { products: products(product()) }, ctx())
      expect(result).toMatchObject({ ok: true, transaction: { pax_count: 1, senior_count: 0 } })
    }
  })

  it("refuses an unknown payment method", () => {
    const result = buildSale(
      { lines: [{ productId: "soap", quantity: 1 }], paymentMethod: "BITCOIN" as never },
      { products: products(product()) },
      ctx()
    )
    expect(result).toMatchObject({ ok: false, code: "INVALID_PAYMENT_METHOD" })
  })

  it("issues the terminal's next SI number and returns the one after", () => {
    const result = buildSale({ lines: [{ productId: "soap", quantity: 1 }] }, { products: products(product()) }, ctx())
    expect(result).toMatchObject({ ok: true, transaction: { invoice_number: "SI-000041" }, nextInvoiceNumber: 42 })
  })

  it("checks stock across repeated lines of the same product", () => {
    const lines = [
      { productId: "soap", quantity: 6 },
      { productId: "soap", quantity: 5 },
    ]
    expect(buildSale({ lines }, { products: products(product({ stock_level: 10 })) }, ctx())).toMatchObject({
      ok: false,
      code: "INSUFFICIENT_STOCK",
    })
    expect(buildSale({ lines }, { products: products(product({ stock_level: 11 })) }, ctx())).toMatchObject({ ok: true })
  })

  it("detects a one-centavo price change against the total the cashier was shown", () => {
    const shown = calculateTransactionTotals([{ product: product({ selling_price: 25 }), quantity: 2 }], 1, 0).netSales
    const now = products(product({ selling_price: 25.01 }))
    expect(buildSale({ lines: [{ productId: "soap", quantity: 2 }], expectedNetSales: shown }, { products: now }, ctx())).toMatchObject({
      ok: false,
      code: "PRICES_CHANGED",
    })
  })

  it("is deterministic: the same input and context give the same records", () => {
    const run = () => buildSale({ lines: [{ productId: "soap", quantity: 3 }], amountTendered: 100 }, { products: products(product()) }, ctx())
    expect(run()).toEqual(run())
  })

  it("does not touch the input product rows", () => {
    const p = product()
    const snapshot = JSON.parse(JSON.stringify(p))
    buildSale({ lines: [{ productId: "soap", quantity: 3 }] }, { products: products(p) }, ctx())
    expect(p).toEqual(snapshot)
  })
})
