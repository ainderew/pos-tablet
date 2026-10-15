// buildVoid rules beyond the POS-bir parity scenarios
import { describe, expect, it } from "vitest"
import { buildSale, buildVoid } from "../src"
import type { Product, VoidContext, VoidData } from "../src"

const soap = {
  id: "soap", name: "Soap", barcode: null, selling_price: 25, cost_price: 18, stock_level: 10, unit_type: "QUANTITY",
  low_stock_threshold: 0, notify_low_stock: false, category_id: null, tax_category: "VATABLE", supplier_type: "WHOLESALER",
  is_promo: false, promo_price: null, pos_id: "x", is_synced: false,
} as Product

const shift = { id: "shift-1", store_id: "store-1", terminal_id: "terminal-1" }
let n = 0
const ids = () => `id-${++n}`
let seq = 0
const seqs = () => ++seq

const sell = (paymentMethod: "CASH" | "STORE_CREDIT" = "CASH") => {
  const result = buildSale(
    { lines: [{ productId: "soap", quantity: 2 }, { productId: "soap", quantity: 1 }], paymentMethod, referenceNumber: paymentMethod === "STORE_CREDIT" ? "rosa" : null },
    {
      products: new Map([["soap", soap]]),
      openShift: shift,
      customer: { id: "rosa", credit_limit: 1000, current_debt_balance: 0, credit_status: "ACTIVE" },
    },
    { storeId: "store-1", terminalId: "terminal-1", cashierId: "u", now: new Date("2026-10-15T01:00:00Z"), newId: ids, nextSeq: seqs, nextInvoiceNumber: 1 }
  )
  if (!result.ok) throw new Error(result.code)
  return result
}

const ctx = (overrides: Partial<VoidContext> = {}): VoidContext => ({
  storeId: "store-1",
  terminalId: "terminal-1",
  cashierId: "u",
  now: new Date("2026-10-15T02:00:00Z"),
  newId: ids,
  nextSeq: seqs,
  nextCreditNoteNumber: 1,
  ...overrides,
})

describe("buildVoid rules", () => {
  const sale = sell()
  const base: VoidData = { openShift: shift, original: sale.transaction, items: sale.items, alreadyVoided: false }
  const voidWith = (data: Partial<VoidData>, c: Partial<VoidContext> = {}) => buildVoid({ authorizedBy: "mgr", reason: "x" }, { ...base, ...data }, ctx(c))

  it("voids a complete sale on its own terminal", () => {
    expect(voidWith({})).toMatchObject({ ok: true, creditNote: { invoice_number: "CN-000001", net_sales: -75 } })
  })

  it("needs an open shift on this terminal", () => {
    expect(voidWith({ openShift: null })).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
    expect(voidWith({ openShift: { ...shift, terminal_id: "terminal-2" } })).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
  })

  it("only lets the issuing terminal void a sale", () => {
    const fromOther = { ...sale.transaction, terminal_id: "terminal-2" }
    expect(voidWith({ original: fromOther })).toMatchObject({ ok: false, code: "WRONG_TERMINAL" })
  })

  it("refuses missing, partial or foreign lines instead of silently restoring less stock", () => {
    expect(voidWith({ items: [] })).toMatchObject({ ok: false, code: "ITEMS_MISMATCH" })
    expect(voidWith({ items: sale.items.slice(0, 1) })).toMatchObject({ ok: false, code: "ITEMS_MISMATCH" })
    const foreign = sale.items.map((i, k) => (k === 0 ? { ...i, transaction_id: "other-sale" } : i))
    expect(voidWith({ items: foreign })).toMatchObject({ ok: false, code: "ITEMS_MISMATCH" })
  })

  it("refuses a store-credit void when the customer isn't known on this terminal", () => {
    const credit = sell("STORE_CREDIT")
    const data = { original: credit.transaction, items: credit.items }
    expect(voidWith({ ...data, customer: null })).toMatchObject({ ok: false, code: "CUSTOMER_NOT_FOUND" })
    expect(voidWith({ ...data, customer: { id: "someone-else", current_debt_balance: 75 } })).toMatchObject({ ok: false, code: "CUSTOMER_NOT_FOUND" })
    expect(voidWith({ ...data, customer: { id: "rosa", current_debt_balance: 75 } })).toMatchObject({ ok: true, customerBalanceAfter: 0 })
  })
})
