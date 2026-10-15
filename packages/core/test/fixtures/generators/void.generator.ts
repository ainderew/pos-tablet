/**
 * @jest-environment node
 */
// Runs POS-bir's real sale + void routes and records the credit notes they produce (golden parity).
import * as fs from "fs"
import { execSync } from "child_process"
import bcrypt from "bcryptjs"
import { query, closeDb } from "@/lib/db"
import { getActivePrice } from "@/lib/ph-tax"
import { ensureSchema } from "/Users/drew/Desktop/projects/POS-bir/__tests__/db/_setup"
import { POST as SELL } from "/Users/drew/Desktop/projects/POS-bir/app/api/transactions/route"
import { POST as VOID } from "/Users/drew/Desktop/projects/POS-bir/app/api/transactions/void/route"

const OUT = "/Users/drew/Desktop/projects/pos-tablet/packages/core/test/fixtures/pc-void-parity.json"
const MANAGER = { id: "mgr-1", pin: "4321" }
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
  P("fifty", { name: "Fifty Item", selling_price: 50, cost_price: 30, stock_level: 100 }),
]
const CUSTOMERS = [{ id: "rosa", full_name: "Aling Rosa", credit_limit: 5000, current_debt_balance: 1500, credit_status: "ACTIVE" }]

type Line = [string, number]
interface Sale { lines: Line[]; body?: Record<string, unknown> }
interface Step { void: number; reason?: string | null }
interface Scenario { name: string; sales: Sale[]; afterSales?: string[]; voids: Step[] }
const SCENARIOS: Scenario[] = [
  { name: "void_cash_mixed_categories", sales: [{ lines: [["soap", 3], ["eggs", 12], ["export", 1]], body: { amount_tendered: 500 } }], voids: [{ void: 0, reason: "Wrong items" }] },
  { name: "void_sc_pwd_sale", sales: [{ lines: [["fifty", 2], ["eggs", 4]], body: { paxCount: 3, seniorCount: 1, scPwdData: { idNumber: "SC-9", name: "Lolo" } } }], voids: [{ void: 0, reason: "Customer changed mind" }] },
  { name: "void_weight_and_wholesale", sales: [{ lines: [["rice", 2.375], ["soap", 12]] }], voids: [{ void: 0, reason: null }] },
  { name: "void_gcash_with_reference", sales: [{ lines: [["export", 2]], body: { payment_method: "GCASH", reference_number: "GC-777" } }], voids: [{ void: 0, reason: "Duplicate" }] },
  { name: "void_store_credit", sales: [{ lines: [["soap", 16]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa" } }], voids: [{ void: 0, reason: "Returned goods" }] },
  // Customer paid the balance down after the charge, so the reversal leaves the store owing them
  { name: "void_store_credit_after_payment", sales: [{ lines: [["fifty", 10]], body: { payment_method: "STORE_CREDIT", reference_number: "rosa" } }],
    afterSales: ["UPDATE customers SET current_debt_balance = 0 WHERE id = 'rosa'"], voids: [{ void: 0, reason: "Paid then returned" }] },
  { name: "two_voids_number_sequentially", sales: [{ lines: [["soap", 1]] }, { lines: [["eggs", 2]] }], voids: [{ void: 0, reason: "a" }, { void: 1, reason: "b" }] },
  { name: "void_already_voided", sales: [{ lines: [["soap", 1]] }], voids: [{ void: 0, reason: "first" }, { void: 0, reason: "again" }] },
  { name: "void_a_credit_note", sales: [{ lines: [["soap", 1]] }], voids: [{ void: 0, reason: "first" }, { void: -1, reason: "void the CN" }] },
]

async function reset() {
  for (const t of ["audit_logs", "credit_ledger", "transaction_items", "transactions", "customers", "products"]) await query(`DELETE FROM ${t}`)
  await query("DELETE FROM users WHERE id = $1", [MANAGER.id])
  await query("UPDATE settings SET value = '1' WHERE key IN ('next_invoice_number', 'next_credit_note_number')")
  await query("INSERT INTO users (id, full_name, pin_hash, role) VALUES ($1, 'Manager One', $2, 'MANAGER')", [MANAGER.id, bcrypt.hashSync(MANAGER.pin, 4)])
  for (const p of PRODUCTS) {
    const cols = Object.keys(p)
    await query(`INSERT INTO products (${cols.join(",")}, pos_id) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}, $${cols.length + 1})`, [...Object.values(p), "pc"])
  }
  for (const c of CUSTOMERS) await query("INSERT INTO customers (id, full_name, credit_limit, current_debt_balance, credit_status, total_spend, pos_id) VALUES ($1,$2,$3,$4,$5,0,'pc')", [c.id, c.full_name, c.credit_limit, c.current_debt_balance, c.credit_status])
}

const post = async (handler: any, body: unknown) => {
  const res = await handler(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() }
}

test("generate golden void fixtures from POS-bir", async () => {
  const results = []
  for (const s of SCENARIOS) {
    await reset()
    const sales: any[] = []
    for (const sale of s.sales) {
      const rows = await query("SELECT * FROM products")
      const byId = new Map(rows.map((r: any) => [r.id, r]))
      const cart = sale.lines.map(([id, quantity]) => ({ product: byId.get(id), quantity, active_price: getActivePrice(byId.get(id) as any, quantity) }))
      const res = await post(SELL, { cart, ...sale.body })
      if (res.status !== 201) throw new Error(`sale failed in ${s.name}: ${JSON.stringify(res.body)}`)
      sales.push(res.body)
    }
    for (const sql of s.afterSales ?? []) await query(sql)
    const steps = []
    let lastCreditNote: any = null
    for (const step of s.voids) {
      const target = step.void === -1 ? lastCreditNote : sales[step.void]
      const before = {
        stock: Object.fromEntries((await query("SELECT id, stock_level FROM products")).map((r: any) => [r.id, r.stock_level])),
        customers: Object.fromEntries((await query("SELECT id, current_debt_balance FROM customers")).map((r: any) => [r.id, r.current_debt_balance])),
        original: (await query("SELECT * FROM transactions WHERE id = $1", [target.id]))[0],
      }
      const res = await post(VOID, { originalTransactionId: target.id, managerId: MANAGER.id, pin: MANAGER.pin, reason: step.reason })
      if (res.status === 200) lastCreditNote = res.body.transaction
      steps.push({
        voidTarget: step.void, reason: step.reason, before,
        status: res.status, response: res.body,
        stockAfter: Object.fromEntries((await query("SELECT id, stock_level FROM products")).map((r: any) => [r.id, r.stock_level])),
        customersAfter: Object.fromEntries((await query("SELECT id, current_debt_balance FROM customers")).map((r: any) => [r.id, r.current_debt_balance])),
        ledger: await query("SELECT customer_id, transaction_id, entry_type, amount, running_balance, notes FROM credit_ledger ORDER BY occurred_at, rowid"),
        originalAfter: (await query("SELECT status, void_reason, void_authorized_by FROM transactions WHERE id = $1", [target.id]))[0],
      })
    }
    const items = await query("SELECT ti.*, p.name AS product_name, p.unit_type FROM transaction_items ti JOIN products p ON p.id = ti.product_id")
    results.push({ name: s.name, sales, items, steps })
  }
  const commit = execSync("git -C /Users/drew/Desktop/projects/POS-bir rev-parse --short HEAD").toString().trim()
  fs.writeFileSync(OUT, JSON.stringify({ generatedFrom: `POS-bir@${commit}`, manager: MANAGER.id, scenarios: results }, null, 2) + "\n")
  expect(results).toHaveLength(SCENARIOS.length)
})
