// Ported from POS-bir __tests__/api/sales.test.ts ("ph-tax rounding") - must keep passing unchanged
// so the tablet, the server and the PC app compute identical BIR totals.
import { describe, expect, it } from "vitest"
import { calculateTransactionTotals, getActivePrice, lessVatOf, roundMoney, toCents } from "../src"
import type { CartItem, Product, TaxCategory } from "../src"

describe("ph-tax rounding", () => {
  let nextId = 0 // core has no Node/DOM globals, so no crypto.randomUUID() here
  const product = (overrides: Partial<Product> = {}): Product => ({
    id: `p-${++nextId}`,
    name: "P",
    barcode: null,
    selling_price: 100,
    cost_price: 50,
    stock_level: 1000,
    unit_type: "QUANTITY",
    low_stock_threshold: 0,
    notify_low_stock: false,
    category_id: null,
    tax_category: "VATABLE",
    supplier_type: "WHOLESALER",
    is_promo: false,
    promo_price: null,
    pos_id: "test",
    is_synced: false,
    ...overrides,
  } as Product)

  it("roundMoney rounds half away from zero despite binary error", () => {
    expect(roundMoney(1.005)).toBe(1.01)
    expect(roundMoney(-1.005)).toBe(-1.01)
    expect(roundMoney(35.714285714285715)).toBe(35.71)
    expect(roundMoney(0.1 + 0.2)).toBe(0.3)
    expect(roundMoney(799.9999999999999)).toBe(800)
    expect(toCents(35.71)).toBe(3571)
    expect(toCents(0.1 + 0.2)).toBe(30)
  })

  it("getActivePrice switches to wholesale at the threshold", () => {
    const p = product({ selling_price: 100, wholesale_price: 80, wholesale_threshold: 10 })
    expect(getActivePrice(p, 9)).toBe(100)
    expect(getActivePrice(p, 10)).toBe(80)
    expect(getActivePrice(product({ wholesale_price: 80, wholesale_threshold: 0 }), 50)).toBe(100)
    expect(getActivePrice(product({ wholesale_price: null, wholesale_threshold: 5 }), 50)).toBe(100)
  })

  it("lessVatOf makes stored SC/PWD totals add up on a receipt, and is absent otherwise", () => {
    const sc = { gross_sales: 100, vatable_sales: 0, vat_amount: 0, vat_exempt_sales: 89.29, zero_rated_sales: 0, total_discount: 17.86, net_sales: 71.43 }
    expect(lessVatOf(sc)).toBe(10.71)
    expect(roundMoney(sc.gross_sales - lessVatOf(sc)! - sc.total_discount)).toBe(sc.net_sales)
    expect(lessVatOf({ gross_sales: "-100", vatable_sales: "0", vat_amount: "0", vat_exempt_sales: "-89.29", zero_rated_sales: "0" })).toBe(-10.71)
    expect(lessVatOf({ gross_sales: 112, vatable_sales: 100, vat_amount: 12, vat_exempt_sales: 0, zero_rated_sales: null })).toBeUndefined()
  })

  it("SC/PWD ₱50 VATABLE item: rounded parts add up", () => {
    const totals = calculateTransactionTotals([{ product: product({ selling_price: 50 }), quantity: 1 }], 1, 1)
    expect(totals).toEqual({
      grossSales: 50,
      vatableSales: 0,
      vatAmount: 0,
      vatExemptSales: 44.64,
      zeroRatedSales: 0,
      totalDiscount: 8.93,
      netSales: 35.71,
    })
  })

  it("'Exact' tender always covers the SC/PWD total", () => {
    for (let cents = 100; cents <= 50000; cents += 25) {
      const p = product({ selling_price: cents / 100 })
      const { netSales } = calculateTransactionTotals([{ product: p, quantity: 1 }], 1, 1)
      const exact = parseFloat(netSales.toFixed(2))
      expect(toCents(exact) >= toCents(netSales)).toBe(true)
      expect(exact).toBe(netSales)
    }
  })

  it("keeps every field in centavos and the BIR breakdown consistent", () => {
    // Deterministic pseudo-random carts
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const categories: TaxCategory[] = ["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]

    for (let n = 0; n < 500; n++) {
      const items: CartItem[] = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => {
        const weight = rand() < 0.3
        const p = product({
          selling_price: Math.round(25 + rand() * 99975) / 100,
          tax_category: categories[Math.floor(rand() * 3)],
          unit_type: weight ? "WEIGHT" : "QUANTITY",
        })
        const quantity = weight ? Math.round(1 + rand() * 2999) / 1000 : 1 + Math.floor(rand() * 20)
        return { product: p, quantity, active_price: p.selling_price }
      })
      const pax = 1 + Math.floor(rand() * 5)
      const seniors = Math.floor(rand() * (pax + 1))
      const t = calculateTransactionTotals(items, pax, seniors)

      for (const value of Object.values(t)) expect(roundMoney(value)).toBe(value)

      const c = {
        gross: toCents(t.grossSales), vatable: toCents(t.vatableSales), vat: toCents(t.vatAmount),
        exempt: toCents(t.vatExemptSales), zero: toCents(t.zeroRatedSales), discount: toCents(t.totalDiscount),
        net: toCents(t.netSales),
      }
      expect(c.net).toBe(c.vatable + c.vat + c.exempt + c.zero - c.discount)
      expect(Math.abs(t.vatAmount - t.vatableSales * 0.12)).toBeLessThanOrEqual(0.01)
      // Gross equals the sum of the rounded line amounts
      expect(c.gross).toBe(items.reduce((sum, i) => sum + toCents(i.product.selling_price * i.quantity), 0))
      if (seniors === 0) {
        expect(c.vatable + c.vat + c.exempt + c.zero).toBe(c.gross)
        expect(c.discount).toBe(0)
      } else {
        // Seniors' share: VAT removed, then 20% off; never more than gross
        expect(c.net).toBeLessThanOrEqual(c.gross)
      }
    }
  })
})
