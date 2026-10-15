/**
 * @jest-environment node
 */
// Drives POS-bir's real shift, sale, void, cash-movement and Z-reading routes through three business
// days and records what they did, so pos-tablet's @pos/core shift and Z-reading rules can be checked
// against it (golden parity fixtures).
//
// Timestamps: SQLite's datetime('now') has one-second resolution and this whole run takes about a
// second, so after every call the rows it wrote are re-stamped on a synthetic clock, one minute per
// step. POS-bir's SQL only compares these timestamps (shift window, Z period), so this is the same as
// the steps happening a minute apart. Ids come from a counter (crypto.randomUUID is stubbed) so the
// fixture is stable across regenerations.
import * as fs from "fs"
import * as path from "path"
import crypto from "crypto"
import bcrypt from "bcryptjs"
import { execSync } from "child_process"
import { query, queryOne, closeDb } from "@/lib/db"
import { getActivePrice } from "@/lib/ph-tax"
import { ensureSchema } from "/Users/drew/Desktop/projects/POS-bir/__tests__/db/_setup"
import { POST as SELL } from "/Users/drew/Desktop/projects/POS-bir/app/api/transactions/route"
import { POST as VOID } from "/Users/drew/Desktop/projects/POS-bir/app/api/transactions/void/route"
import { GET as CURRENT_SHIFT, POST as OPEN_SHIFT } from "/Users/drew/Desktop/projects/POS-bir/app/api/shifts/current/route"
import { POST as CLOSE_SHIFT } from "/Users/drew/Desktop/projects/POS-bir/app/api/shifts/close/route"
import { POST as CASH_MOVEMENT } from "/Users/drew/Desktop/projects/POS-bir/app/api/cash-movements/route"
import { GET as Z_PREVIEW, POST as Z_READING } from "/Users/drew/Desktop/projects/POS-bir/app/api/reports/z-reading/route"
import { POST as CREDIT_PAYMENT } from "/Users/drew/Desktop/projects/POS-bir/app/api/customers/payment/route"

const OUT = "/Users/drew/Desktop/projects/pos-tablet/packages/core/test/fixtures/pc-shift-z-parity.json"
jest.setTimeout(60000)

const POS_ID = "pc-golden"
const TERMINAL = "terminal-pc-1"
const LEGACY_TERMINAL = "terminal-pc-legacy"
const MANAGER = "user-manager"
const CASHIER = "user-cashier"
const INACTIVE = "user-inactive"
const MANAGER_PIN = "4321"
const Z_PIN = "1234" // the schema's default settings.manager_pin
const OPENING_GRAND_TOTAL = 1000.5 // a migrated install: settings and terminal agree before the first Z

let uuidN = 0
beforeAll(async () => {
  process.env.POS_ID = POS_ID
  jest.spyOn(crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`
  )
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
  ensureSchema()
})
afterAll(() => closeDb())

const P = (id: string, o: Record<string, unknown>) => ({ id, name: id, barcode: null, selling_price: 100, cost_price: 50, stock_level: 1000,
  unit_type: "QUANTITY", low_stock_threshold: 0, notify_low_stock: 0, category_id: null, tax_category: "VATABLE", supplier_type: "WHOLESALER",
  is_promo: 0, promo_price: null, wholesale_price: null, wholesale_threshold: 0, ...o })
const PRODUCTS = [
  P("soap", { name: "Laundry Soap Bar", selling_price: 25, cost_price: 18, wholesale_price: 21, wholesale_threshold: 12 }),
  P("eggs", { name: "Fresh Eggs", selling_price: 8.75, cost_price: 7, tax_category: "VAT_EXEMPT" }),
  P("rice", { name: "Rice (per kg)", selling_price: 52.5, cost_price: 45, unit_type: "WEIGHT" }),
  P("export", { name: "Export Item", selling_price: 120, cost_price: 90, tax_category: "ZERO_RATED" }),
  P("odd", { name: "Odd Price", selling_price: 33.33, cost_price: 20 }),
]

// Synthetic clock (SQLite's "YYYY-MM-DD HH:MM:SS", UTC)
let clock = 0
const startDay = (isoDate: string) => { clock = Date.parse(`${isoDate}T00:00:00Z`) }
const tick = () => { clock += 60_000; return new Date(clock).toISOString().slice(0, 19).replace("T", " ") }

const req = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const steps: Record<string, unknown>[] = []
let openShiftId: string | null = null

// Rows a call added to a table (ids are a counter, but this doesn't rely on it)
const idsIn = async (table: string) => new Set((await query(`SELECT id FROM ${table}`)).map((r: any) => r.id as string))
async function restampNew(table: string, before: Set<string>, column: string, at: string) {
  const added = [...(await idsIn(table))].filter((id) => !before.has(id))
  for (const id of added) await query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [at, id])
  return added
}

async function openShift(name: string, body: Record<string, unknown>) {
  const res = await OPEN_SHIFT(req("/api/shifts/current", body))
  const json = await res.json()
  const at = tick()
  let response = json
  if (res.status === 201) {
    await query("UPDATE shifts SET start_time = $1 WHERE id = $2", [at, json.id])
    await query("UPDATE audit_logs SET created_at = $1 WHERE shift_id = $2", [at, json.id])
    response = await queryOne("SELECT * FROM shifts WHERE id = $1", [json.id])
    openShiftId = json.id
    // GET /api/shifts/current now returns it
    expect((await (await CURRENT_SHIFT()).json()).id).toBe(json.id)
  }
  steps.push({ kind: "open_shift", name, at, request: body, status: res.status, response })
  return response
}

type Line = [string, number]
async function sell(name: string, lines: Line[], body: Record<string, unknown>) {
  const products = await query("SELECT * FROM products")
  const cart = lines.map(([id, quantity]) => {
    const product = products.find((p: any) => p.id === id)
    return { product, quantity, active_price: getActivePrice(product, quantity) }
  })
  const ledgerBefore = await idsIn("credit_ledger")
  const res = await SELL(req("/api/transactions", { cart, ...body }))
  const json = await res.json()
  expect(res.status).toBe(201)
  const at = tick()
  await query("UPDATE transactions SET created_at = $1 WHERE id = $2", [at, json.id])
  const ledgerIds = await restampNew("credit_ledger", ledgerBefore, "occurred_at", at)
  steps.push({ kind: "sale", name, at, shiftId: openShiftId, lines, request: body, status: res.status, transactionId: json.id, invoiceNumber: json.invoice_number, ledgerIds })
  return json
}

async function voidSale(name: string, sale: { id: string }, reason: string) {
  const ledgerBefore = await idsIn("credit_ledger")
  const res = await VOID(req("/api/transactions/void", { originalTransactionId: sale.id, managerId: MANAGER, pin: MANAGER_PIN, reason }))
  const json = await res.json()
  expect(res.status).toBe(200)
  const at = tick()
  await query("UPDATE transactions SET created_at = $1, voided_at = $1 WHERE id = $2", [at, json.transaction.id])
  await query("UPDATE transactions SET voided_at = $1 WHERE id = $2", [at, sale.id])
  const ledgerIds = await restampNew("credit_ledger", ledgerBefore, "occurred_at", at)
  steps.push({ kind: "void", name, at, shiftId: openShiftId, originalTransactionId: sale.id, status: res.status, creditNoteId: json.transaction.id, invoiceNumber: json.transaction.invoice_number, ledgerIds })
}

async function cashMovement(name: string, body: Record<string, unknown>) {
  const res = await CASH_MOVEMENT(req("/api/cash-movements", body))
  const json = await res.json()
  const at = tick()
  let response = json
  if (res.status === 201) {
    await query("UPDATE cash_movements SET created_at = $1 WHERE id = $2", [at, json.id])
    response = await queryOne("SELECT * FROM cash_movements WHERE id = $1", [json.id])
  }
  steps.push({ kind: "cash_movement", name, at, shiftId: openShiftId, request: body, status: res.status, response })
}

// A store-credit payment at the counter; a CASH one also records a CASH_IN into the shift
async function creditPayment(name: string, body: Record<string, unknown>) {
  const ledgerBefore = await idsIn("credit_ledger")
  const movementsBefore = await idsIn("cash_movements")
  const res = await CREDIT_PAYMENT(req("/api/customers/payment", body))
  const json = await res.json()
  expect(res.status).toBe(200)
  const at = tick()
  const ledgerIds = await restampNew("credit_ledger", ledgerBefore, "occurred_at", at)
  const cashMovementIds = await restampNew("cash_movements", movementsBefore, "created_at", at)
  steps.push({ kind: "credit_payment", name, at, shiftId: openShiftId, request: body, status: res.status, response: json, ledgerIds, cashMovementIds })
}

async function closeShift(name: string, body: Record<string, unknown>) {
  const res = await CLOSE_SHIFT(req("/api/shifts/close", body))
  const json = await res.json()
  const at = tick()
  let response = json
  let audit = null
  if (res.status === 200) {
    await query("UPDATE shifts SET end_time = $1 WHERE id = $2", [at, json.id])
    await query("UPDATE audit_logs SET created_at = $1 WHERE shift_id = $2 AND action_type = 'SHIFT_CLOSE'", [at, json.id])
    response = await queryOne("SELECT * FROM shifts WHERE id = $1", [json.id])
    audit = JSON.parse((await queryOne("SELECT audit_metadata FROM audit_logs WHERE shift_id = $1 AND action_type = 'SHIFT_CLOSE'", [json.id])).audit_metadata)
    openShiftId = null
  }
  steps.push({ kind: "close_shift", name, at, request: body, status: res.status, response, audit })
}

async function zPreview(name: string) {
  const res = await Z_PREVIEW()
  const at = tick()
  steps.push({ kind: "z_preview", name, at, status: res.status, response: await res.json() })
}

async function zReading(name: string, terminalId: string) {
  const body = { pin: Z_PIN, terminalId }
  const res = await Z_READING(req("/api/reports/z-reading", body))
  const json = await res.json()
  expect(res.status).toBe(200)
  const at = tick()
  await query("UPDATE daily_readings SET reading_date = $1 WHERE id = $2", [at, json.id])
  const terminal = await queryOne("SELECT id, accumulated_grand_total, last_z_counter FROM terminals WHERE id = $1", [terminalId])
  const settingsGrandTotal = (await queryOne("SELECT value FROM settings WHERE key = 'accumulated_grand_total'")).value
  steps.push({ kind: "z_reading", name, at, request: { terminalId }, status: res.status, response: { ...json, reading_date: at }, terminalAfter: terminal, settingsGrandTotal })
  return json
}

async function addTerminal(name: string, terminal: { id: string; accumulated_grand_total: number; last_z_counter: number }) {
  await query(
    "INSERT INTO terminals (id, pos_id, ptu_number, serial_number, accumulated_grand_total, last_z_counter) VALUES ($1, $2, $3, $4, $5, $6)",
    [terminal.id, POS_ID, `PTU-${terminal.id}`, `SN-${terminal.id}`, terminal.accumulated_grand_total, terminal.last_z_counter]
  )
  const zCount = (await queryOne("SELECT COUNT(*) as count FROM daily_readings WHERE type = 'Z'")).count
  steps.push({ kind: "add_terminal", name, at: tick(), terminal, zReadingsSoFar: zCount })
}

test("generate golden shift and Z-reading fixtures from POS-bir", async () => {
  // Seed: users (manager with a known PIN), a terminal, products, a credit customer
  for (const [id, name, role, pin, active] of [
    [MANAGER, "Golden Manager", "MANAGER", MANAGER_PIN, 1],
    [CASHIER, "Golden Cashier", "CASHIER", "1111", 1],
    [INACTIVE, "Former Cashier", "CASHIER", "2222", 0],
  ] as const) {
    await query("INSERT INTO users (id, full_name, pin_hash, role, is_active) VALUES ($1, $2, $3, $4, $5)", [id, name, await bcrypt.hash(pin, 4), role, active])
  }
  await query(
    "INSERT INTO terminals (id, pos_id, ptu_number, serial_number, accumulated_grand_total, last_z_counter) VALUES ($1, $2, 'PTU-1', 'SN-1', $3, 0)",
    [TERMINAL, POS_ID, OPENING_GRAND_TOTAL]
  )
  await query("UPDATE settings SET value = $1 WHERE key = 'accumulated_grand_total'", [OPENING_GRAND_TOTAL.toFixed(2)])
  for (const p of PRODUCTS) {
    const cols = Object.keys(p)
    await query(`INSERT INTO products (${cols.join(",")}, pos_id) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}, $${cols.length + 1})`, [...Object.values(p), POS_ID])
  }
  await query("INSERT INTO customers (id, full_name, credit_limit, current_debt_balance, credit_status, total_spend, pos_id) VALUES ('rosa', 'Aling Rosa', 5000, 0, 'ACTIVE', 0, $1)", [POS_ID])
  const initial = {
    terminals: await query("SELECT id, accumulated_grand_total, last_z_counter FROM terminals"),
    users: await query("SELECT id, full_name, role, is_active FROM users"),
    settingsGrandTotal: (await queryOne("SELECT value FROM settings WHERE key = 'accumulated_grand_total'")).value,
  }

  // ---- Day 1 -------------------------------------------------------------------------------------
  startDay("2026-01-05")
  await openShift("open_missing_user", { terminalId: TERMINAL, openingFund: 1000 })
  await openShift("open_unknown_user", { userId: "user-nobody", terminalId: TERMINAL, openingFund: 1000 })
  await openShift("open_inactive_user", { userId: INACTIVE, terminalId: TERMINAL, openingFund: 1000 })
  await openShift("open_shift_1", { userId: CASHIER, terminalId: TERMINAL, openingFund: 1000 })
  await openShift("open_while_open", { userId: MANAGER, terminalId: TERMINAL, openingFund: 500 })

  const s1 = await sell("s1_cash_mixed", [["soap", 3], ["eggs", 12], ["export", 1]], { payment_method: "CASH", amount_tendered: 500 })
  await sell("s2_gcash", [["eggs", 30], ["soap", 1]], { payment_method: "GCASH", reference_number: "GC-1001" })
  await sell("s3_maya_weighed", [["rice", 1.375]], { payment_method: "MAYA", reference_number: "MY-2002" })
  await sell("s4_card", [["export", 2]], { payment_method: "CARD", reference_number: "4242" })
  const s5 = await sell("s5_store_credit", [["soap", 16]], { payment_method: "STORE_CREDIT", reference_number: "rosa" })
  const s6 = await sell("s6_cash_sc_group", [["soap", 4], ["eggs", 6], ["export", 1], ["rice", 2.25]],
    { payment_method: "CASH", paxCount: 4, seniorCount: 2, scPwdData: { idNumber: "SC-2", name: "Lolo" }, amount_tendered: 1000 })
  const s7 = await sell("s7_cash_voided_same_shift", [["odd", 3]], { payment_method: "CASH", amount_tendered: 100 })
  const s8 = await sell("s8_gcash_wholesale_voided_next_shift", [["soap", 12]], { payment_method: "GCASH", reference_number: "GC-1002" })
  const s9 = await sell("s9_cash_voided_next_shift", [["odd", 7]], { payment_method: "CASH" })
  await sell("s10_pwd_maya", [["odd", 2], ["eggs", 3]],
    { payment_method: "MAYA", reference_number: "MY-2003", paxCount: 1, seniorCount: 1, scPwdData: { idNumber: "PWD-9", name: "Juan" } })
  await voidSale("void_s7_same_shift", s7, "Wrong item")

  await cashMovement("cash_in_change_fund", { shiftId: openShiftId, type: "CASH_IN", amount: 500, reason: "Change fund top-up" })
  await cashMovement("cash_out_ice", { shiftId: openShiftId, type: "CASH_OUT", amount: 120.5, reason: "Ice delivery" })
  await cashMovement("cash_out_odd_cents", { shiftId: openShiftId, type: "CASH_OUT", amount: 33.33, reason: "Load" })
  await cashMovement("safe_drop_midday", { shiftId: openShiftId, type: "SAFE_DROP", amount: 1000, reason: "Midday safe drop" })
  await cashMovement("movement_amount_as_string", { shiftId: openShiftId, type: "CASH_IN", amount: "0.10", reason: "Coins" })
  await cashMovement("movement_missing_reason", { shiftId: openShiftId, type: "CASH_IN", amount: 50, reason: "" })
  await cashMovement("movement_zero_amount", { shiftId: openShiftId, type: "CASH_OUT", amount: 0, reason: "Nothing" })
  await cashMovement("movement_missing_type", { shiftId: openShiftId, amount: 50, reason: "No type" })
  await cashMovement("movement_invalid_type", { shiftId: openShiftId, type: "TIP", amount: 50, reason: "Tip jar" })

  const shift1 = openShiftId
  await closeShift("close_missing_actual_cash", { shiftId: shift1, actualGcash: 0, actualMaya: 0, actualCard: 0 })
  await closeShift("close_shift_1", { shiftId: shift1, actualCash: 1500, actualGcash: 1000.75, actualMaya: 100, actualCard: 240 })
  await closeShift("close_shift_1_again", { shiftId: shift1, actualCash: 1500, actualGcash: 0, actualMaya: 0, actualCard: 0 })

  await openShift("open_shift_2", { userId: MANAGER, terminalId: TERMINAL, openingFund: 500.25 })
  await voidSale("void_s8_gcash_from_shift_1", s8, "Customer returned")
  await voidSale("void_s9_cash_from_shift_1", s9, "Overcharged")
  await voidSale("void_s5_store_credit_from_shift_1", s5, "Charged wrong customer")
  await sell("s11_cash", [["soap", 2], ["eggs", 4]], { payment_method: "CASH", amount_tendered: 100 })
  await sell("s12_card", [["export", 1]], { payment_method: "CARD", reference_number: "5555" })
  await cashMovement("cash_out_supplies", { shiftId: openShiftId, type: "CASH_OUT", amount: 50, reason: "Supplies" })
  await closeShift("close_shift_2", { shiftId: openShiftId, actualCash: 450, actualGcash: 0, actualMaya: 0, actualCard: 120 })

  await zPreview("z1_preview")
  await zReading("z1", TERMINAL)

  // ---- Day 2 -------------------------------------------------------------------------------------
  startDay("2026-01-06")
  await openShift("open_shift_3", { userId: CASHIER, terminalId: TERMINAL, openingFund: 1000 })
  await sell("s13_cash", [["rice", 3.5], ["odd", 1]], { payment_method: "CASH", amount_tendered: 500 })
  await sell("s14_maya", [["eggs", 10]], { payment_method: "MAYA", reference_number: "MY-3001" })
  const s15 = await sell("s15_cash_voided_same_period", [["soap", 5]], { payment_method: "CASH", amount_tendered: 200 })
  await voidSale("void_s6_sc_sale_from_before_z1", s6, "SC ID invalid")
  await voidSale("void_s15_same_period", s15, "Duplicate")
  await sell("s16_store_credit", [["soap", 10]], { payment_method: "STORE_CREDIT", reference_number: "rosa" })
  // Debt payments: POS-bir expects the cash one (via its CASH_IN) but never the GCash one
  await creditPayment("debt_payment_cash", { customerId: "rosa", amount: 100, paymentMethod: "CASH", shiftId: openShiftId })
  await creditPayment("debt_payment_gcash", { customerId: "rosa", amount: 120.5, paymentMethod: "GCASH", reference: "GC-7001", shiftId: openShiftId, notes: "Partial" })
  await cashMovement("safe_drop_day_2", { shiftId: openShiftId, type: "SAFE_DROP", amount: 500, reason: "Evening drop" })
  await closeShift("close_shift_3", { shiftId: openShiftId, actualCash: 0, actualGcash: 120.5, actualMaya: 87.5, actualCard: 0 })
  await zPreview("z2_preview")
  await zReading("z2", TERMINAL)

  // An empty Z (nothing since z2)
  await zPreview("z3_preview")
  await zReading("z3", TERMINAL)

  // ---- Day 3: upgraded install ---------------------------------------------------------------------
  // A terminal row from before the Z counter existed: the old shift-close code inflated its GT and it
  // was never Z-read, so POS-bir continues the reported chain from the last Z (GT and Z count).
  startDay("2026-01-07")
  await addTerminal("legacy_terminal", { id: LEGACY_TERMINAL, accumulated_grand_total: 99999, last_z_counter: 0 })
  await zPreview("z4_preview")
  await zReading("z4_legacy_terminal", LEGACY_TERMINAL)

  const tables = {
    transactions: await query("SELECT * FROM transactions ORDER BY created_at, invoice_number"),
    shifts: await query("SELECT * FROM shifts ORDER BY start_time"),
    cash_movements: await query("SELECT * FROM cash_movements ORDER BY created_at"),
    credit_ledger: await query("SELECT * FROM credit_ledger ORDER BY occurred_at, id"),
    daily_readings: await query("SELECT * FROM daily_readings ORDER BY reading_date"),
    terminals: await query("SELECT id, accumulated_grand_total, last_z_counter, current_state FROM terminals ORDER BY id"),
  }

  const commit = execSync("git -C /Users/drew/Desktop/projects/POS-bir rev-parse --short HEAD").toString().trim()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedFrom: `POS-bir@${commit}`, posId: POS_ID, initial, steps, tables }, null, 2) + "\n"
  )
  expect(steps.length).toBeGreaterThan(40)
})
