/**
 * @jest-environment node
 */
// Runs POS-bir's real POST /api/transactions for a set of scenarios and records what it did, so
// pos-tablet's @pos/core buildSale can be checked against it (golden parity fixtures).
import * as fs from "fs"
import { execSync } from "child_process"
import { query, queryOne, closeDb } from "@/lib/db"
import { getActivePrice } from "@/lib/ph-tax"
import { ensureSchema } from "/Users/drew/Desktop/projects/POS-bir/__tests__/db/_setup"
import { POST } from "/Users/drew/Desktop/projects/POS-bir/app/api/transactions/route"

const OUT = "/Users/drew/Desktop/projects/pos-tablet/packages/core/test/fixtures/pc-sale-parity.json"
jest.setTimeout(60000)
beforeAll(() => { ensureSchema(); jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}) })
afterAll(() => closeDb())

const P = (id: string, o: Record<string, unknown>) => ({ id, name: id, barcode: null, selling_price: 100, cost_price: 50, stock_level: 100,
  unit_type: "QUANTITY", low_stock_threshold: 0, notify_low_stock: 0, category_id: null, tax_category: "VATABLE", supplier_type: "WHOLESALER",
  is_promo: 0, promo_price: null, wholesale_price: null, wholesale_threshold: 0, ...o })
const PRODUCTS = [
  P("soap", { name: "Laundry Soap Bar", selling_price: 25, cost_price: 18, stock_level: 200, wholesale_price: 21, wholesale_threshold: 12 }),
  P("eggs", { name: "Fresh Eggs", selling_price: 8.75, cost_price: 7, stock_level: 300, tax_category: "VAT_EXEMPT" }),
  P("rice", { name: "Rice (per kg)", selling_price: 52.5, cost_price: 45, stock_level: 120, unit_type: "WEIGHT" }),
  P("export", { name: "Export Item", selling_price: 120, cost_price: 90, stock_level: 50, tax_category: "ZERO_RATED" }),
  P("oil", { name: "Cooking Oil 1L", selling_price: 98, cost_price: 82, stock_level: 3, wholesale_price: 92, wholesale_threshold: 6 }),
  P("odd", { name: "Odd Price", selling_price: 33.33, cost_price: 20, stock_level: 100 }),
  P("free", { name: "Free Sample", selling_price: 0, cost_price: 0, stock_level: 100 }),
  P("fifty", { name: "Fifty Item", selling_price: 50, cost_price: 30, stock_level: 100 }),
]
const CUSTOMERS = [
  { id: "rosa", full_name: "Aling Rosa", credit_limit: 2000, current_debt_balance: 1500, credit_status: "ACTIVE" },
  { id: "ben", full_name: "Mang Ben", credit_limit: 1000, current_debt_balance: 0, credit_status: "BLOCKED" },
]

type Line = [string, number] // product id, quantity
interface Scenario { name: string; lines: Line[]; body?: Record<string, unknown>; stalePrices?: Record<string, number>; extraCartIds?: string[] }
const SCENARIOS: Scenario[] = [
  { name: "cash_mixed_categories_with_change", lines: [["soap", 3], ["eggs", 12], ["export", 1]], body: { payment_method: "CASH", amount_tendered: 500 } },
  { name: "cash_without_tender", lines: [["soap", 2]], body: { payment_method: "CASH" } },
  { name: "cash_exact_tender", lines: [["odd", 3]], body: { payment_method: "CASH", amount_tendered: 99.99 } },
  { name: "cash_tender_as_string", lines: [["fifty", 1]], body: { payment_method: "CASH", amount_tendered: "100" } },
  { name: "wholesale_below_threshold", lines: [["soap", 11]], body: { amount_tendered: 1000 } },
  { name: "wholesale_at_threshold", lines: [["soap", 12]], body: { amount_tendered: 1000 } },
  { name: "weight_item", lines: [["rice", 1.375]], body: { amount_tendered: 100 } },
  { name: "sc_single_fifty_exact", lines: [["fifty", 1]], body: { paxCount: 1, seniorCount: 1, scPwdData: { idNumber: "SC-1", name: "Lola" }, amount_tendered: 35.71 } },
  { name: "sc_group_mixed", lines: [["soap", 4], ["eggs", 6], ["export", 1], ["rice", 2.25]], body: { paxCount: 4, seniorCount: 2, scPwdData: { idNumber: "SC-2", name: "Lolo" }, amount_tendered: 1000 } },
  { name: "sc_seven_three_odd", lines: [["odd", 7], ["soap", 12]], body: { paxCount: 7, seniorCount: 3, scPwdData: { idNumber: "PWD-3", name: "Juan" } } },
  { name: "gcash_with_reference", lines: [["eggs", 30], ["soap", 1]], body: { payment_method: "GCASH", reference_number: "GC-123456" } },
  { name: "card_with_reference", lines: [["export", 2]], body: { payment_method: "CARD", reference_number: "4242" } },
  { name: "maya_with_reference", lines: [["soap", 2], ["eggs", 3]], body: { payment_method: "MAYA", reference_number: "MY-42" } },
  { name: "sc_zero_rated_and_wholesale", lines: [["export", 2], ["soap", 12], ["eggs", 5]], body: { paxCount: 2, seniorCount: 1, scPwdData: { idNumber: "SC-5", name: "Lola Nena" }, amount_tendered: 1000 } },
  { name: "store_credit_with_sc_pwd", lines: [["fifty", 4]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa", paxCount: 2, seniorCount: 1, scPwdData: { idNumber: "SC-6", name: "Aling Rosa" } } },
  { name: "store_credit_exactly_at_limit", lines: [["fifty", 10]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa" } },
  { name: "zero_price_item", lines: [["free", 2], ["soap", 1]], body: { amount_tendered: 25 } },
  { name: "store_credit_ok", lines: [["soap", 16]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa" } },
  { name: "store_credit_limit_exceeded", lines: [["soap", 25]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa" } },
  { name: "store_credit_blocked", lines: [["soap", 1]], body: { payment_method: "STORE_CREDIT", reference_number: "ben" } },
  { name: "store_credit_missing_customer", lines: [["soap", 1]], body: { payment_method: "STORE_CREDIT" } },
  { name: "store_credit_unknown_customer", lines: [["soap", 1]], body: { payment_method: "STORE_CREDIT", reference_number: "nobody" } },
  { name: "tender_short", lines: [["fifty", 2]], body: { payment_method: "CASH", amount_tendered: 99.99 } },
  { name: "insufficient_stock", lines: [["soap", 1], ["oil", 4]], body: { amount_tendered: 1000 } },
  { name: "invalid_fractional_quantity", lines: [["soap", 1.5]], body: {} },
  { name: "prices_changed", lines: [["soap", 2]], stalePrices: { soap: 24 }, body: { amount_tendered: 100 } },
  { name: "product_unavailable", lines: [["soap", 1]], extraCartIds: ["ghost"], body: {} },
  { name: "empty_cart", lines: [], body: {} },
]

async function reset() {
  for (const t of ["credit_ledger", "transaction_items", "transactions", "customers", "products"]) await query(`DELETE FROM ${t}`)
  await query("UPDATE settings SET value = '1' WHERE key = 'next_invoice_number'")
  for (const p of PRODUCTS) {
    const cols = Object.keys(p)
    await query(`INSERT INTO products (${cols.join(",")}, pos_id) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}, $${cols.length + 1})`, [...Object.values(p), "pc"])
  }
  for (const c of CUSTOMERS) {
    await query("INSERT INTO customers (id, full_name, credit_limit, current_debt_balance, credit_status, total_spend, pos_id) VALUES ($1,$2,$3,$4,$5,0,'pc')",
      [c.id, c.full_name, c.credit_limit, c.current_debt_balance, c.credit_status])
  }
}

test("generate golden sale fixtures from POS-bir", async () => {
  const results = []
  for (const s of SCENARIOS) {
    await reset()
    const rows = await query("SELECT * FROM products")
    const byId = new Map(rows.map((r: any) => [r.id, r]))
    const cart = s.lines.map(([id, quantity]) => {
      const product = { ...(byId.get(id) as any), ...(s.stalePrices?.[id] !== undefined ? { selling_price: s.stalePrices[id] } : {}) }
      return { product, quantity, active_price: getActivePrice(product, quantity) }
    })
    for (const ghost of s.extraCartIds ?? []) cart.push({ product: { ...(rows[0] as any), id: ghost, name: "Ghost" }, quantity: 1, active_price: 1 })
    const body = { cart, ...s.body }
    const res = await POST(new Request("http://x/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
    const json = await res.json()
    const stockAfter = Object.fromEntries((await query("SELECT id, stock_level FROM products")).map((r: any) => [r.id, r.stock_level]))
    const customersAfter = Object.fromEntries((await query("SELECT id, current_debt_balance FROM customers")).map((r: any) => [r.id, r.current_debt_balance]))
    const ledger = await query("SELECT customer_id, entry_type, amount, running_balance FROM credit_ledger")
    results.push({
      name: s.name,
      products: rows,
      customers: CUSTOMERS,
      request: body,
      status: res.status,
      response: json,
      stockAfter,
      customersAfter,
      ledger,
    })
  }
  const commit = execSync("git -C /Users/drew/Desktop/projects/POS-bir rev-parse --short HEAD").toString().trim()
  fs.mkdirSync(require("path").dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ generatedFrom: `POS-bir@${commit}`, scenarios: results }, null, 2) + "\n")
  expect(results).toHaveLength(SCENARIOS.length)
})
