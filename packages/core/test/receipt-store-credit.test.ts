// Store-credit receipts name the customer instead of printing their id
import { describe, expect, it } from "vitest"
import { buildSale, buildSaleReceipt, renderReceiptHtml } from "../src"
import type { Product } from "../src"

const soap = {
  id: "soap", name: "Soap", barcode: null, selling_price: 25, cost_price: 18, stock_level: 10, unit_type: "QUANTITY",
  low_stock_threshold: 0, notify_low_stock: false, category_id: null, tax_category: "VATABLE", supplier_type: "WHOLESALER",
  is_promo: false, promo_price: null, pos_id: "x", is_synced: false,
} as Product

describe("store-credit sale receipt", () => {
  let n = 0
  const sale = buildSale(
    { lines: [{ productId: "soap", quantity: 2 }], paymentMethod: "STORE_CREDIT", referenceNumber: "8f14e45f-ceea-467a-9575-7a1b2c3d4e5f" },
    {
      products: new Map([["soap", soap]]),
      customer: { id: "8f14e45f-ceea-467a-9575-7a1b2c3d4e5f", credit_limit: 1000, current_debt_balance: 0, credit_status: "ACTIVE" },
    },
    { storeId: "s", terminalId: "t", shiftId: "sh", cashierId: null, now: new Date("2026-10-15T01:00:00Z"), newId: () => `id-${++n}`, nextInvoiceNumber: 1 }
  )
  if (!sale.ok) throw new Error(sale.code)

  it("prints Charged To with the customer's name", () => {
    const html = renderReceiptHtml(buildSaleReceipt(sale.transaction, sale.items, {}, { creditCustomerName: "Aling Rosa" }))
    expect(html).toContain("Charged To")
    expect(html).toContain("Aling Rosa")
    expect(html).not.toContain("8f14e45f")
  })

  it("falls back to the reference when no name is given (POS-bir behaviour)", () => {
    const html = renderReceiptHtml(buildSaleReceipt(sale.transaction, sale.items))
    expect(html).toContain("Reference No")
    expect(html).toContain("8f14e45f")
  })
})
