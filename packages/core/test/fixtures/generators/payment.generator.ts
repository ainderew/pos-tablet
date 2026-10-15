/**
 * @jest-environment node
 */
// Runs POS-bir's real POST /api/customers/payment and records what it did (golden parity).
import * as fs from "fs"
import { execSync } from "child_process"
import { query, closeDb } from "@/lib/db"
import { ensureSchema } from "/Users/drew/Desktop/projects/POS-bir/__tests__/db/_setup"
import { POST } from "/Users/drew/Desktop/projects/POS-bir/app/api/customers/payment/route"

const OUT = "/Users/drew/Desktop/projects/pos-tablet/packages/core/test/fixtures/pc-payment-parity.json"
jest.setTimeout(60000)
beforeAll(() => { ensureSchema(); jest.spyOn(console, "error").mockImplementation(() => {}) })
afterAll(() => closeDb())

const SCENARIOS = [
  { name: "cash_during_shift", customer: { balance: 1500, limit: 2000, status: "ACTIVE" }, body: { amount: 500, paymentMethod: "CASH", shiftId: "shift-1" } },
  { name: "gcash_with_reference_and_notes", customer: { balance: 800, limit: 2000, status: "ACTIVE" }, body: { amount: "250.50", paymentMethod: "GCASH", reference: "GC-555", notes: "Partial" } },
  { name: "cash_without_shift", customer: { balance: 300, limit: 1000, status: "OVERDUE" }, body: { amount: 300, paymentMethod: "CASH" } },
  { name: "overpayment", customer: { balance: 100, limit: 1000, status: "ACTIVE" }, body: { amount: 150, paymentMethod: "MAYA" } },
  { name: "blocked_customer_back_within_limit", customer: { balance: 2500, limit: 2000, status: "BLOCKED" }, body: { amount: 600, paymentMethod: "CASH", shiftId: "shift-1" } },
  { name: "rounding_residue", customer: { balance: 30.3, limit: 1000, status: "ACTIVE" }, body: { amount: 10.1, paymentMethod: "CASH" } },
  { name: "negative_amount", customer: { balance: 100, limit: 1000, status: "ACTIVE" }, body: { amount: -50, paymentMethod: "CASH" } },
  { name: "missing_amount", customer: { balance: 100, limit: 1000, status: "ACTIVE" }, body: { paymentMethod: "CASH" } },
  { name: "unknown_customer", customer: null, body: { amount: 10, paymentMethod: "CASH" } },
]

test("generate golden payment fixtures from POS-bir", async () => {
  const results = []
  for (const s of SCENARIOS) {
    for (const t of ["cash_movements", "credit_ledger", "shifts", "customers"]) await query(`DELETE FROM ${t}`)
    await query("INSERT INTO shifts (id, pos_id, opening_fund) VALUES ('shift-1', 'pc', 1000)")
    if (s.customer) {
      await query("INSERT INTO customers (id, full_name, credit_limit, current_debt_balance, credit_status, total_spend, pos_id) VALUES ('rosa', 'Aling Rosa', $1, $2, $3, 0, 'pc')",
        [s.customer.limit, s.customer.balance, s.customer.status])
    }
    const res = await POST(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId: "rosa", ...s.body }) }))
    results.push({
      name: s.name, customerBefore: s.customer, request: { customerId: "rosa", ...s.body },
      status: res.status, response: await res.json(),
      customerAfter: (await query("SELECT current_debt_balance, credit_status FROM customers WHERE id = 'rosa'"))[0] ?? null,
      ledger: await query("SELECT customer_id, shift_id, entry_type, amount, running_balance, notes FROM credit_ledger"),
      cashMovements: await query("SELECT shift_id, type, amount, reason FROM cash_movements"),
    })
  }
  const commit = execSync("git -C /Users/drew/Desktop/projects/POS-bir rev-parse --short HEAD").toString().trim()
  fs.writeFileSync(OUT, JSON.stringify({ generatedFrom: `POS-bir@${commit}`, scenarios: results }, null, 2) + "\n")
  expect(results).toHaveLength(SCENARIOS.length)
})
