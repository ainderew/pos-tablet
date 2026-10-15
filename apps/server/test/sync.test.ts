// Sync protocol v1 end to end: a paired device pushes records made by the real @pos/core builders,
// and pulls the server's changes back
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildCashMovement,
  buildCreditPayment,
  buildSale,
  buildShiftOpen,
  buildVoid,
  computeShiftClose,
  computeZReading,
  SYNC_PROTOCOL_VERSION,
  terminalCounters,
} from "@pos/core"
import type { Product, PullResponse, PushRecord, ShiftOpenRecord, TransactionItemRecord, TransactionRecord } from "@pos/core"
import { categories, customers, organizations, products, stockMovements, userStores, users } from "@pos/db"
import { POST as LOGIN } from "@/app/api/auth/login/route"
import { POST as PAIR } from "@/app/api/devices/pair/route"
import { POST as CREATE_TERMINAL } from "@/app/api/stores/[storeId]/terminals/route"
import { POST as PAIRING_CODE } from "@/app/api/terminals/[terminalId]/pairing-code/route"
import { POST as UNPAIR } from "@/app/api/terminals/[terminalId]/unpair/route"
import { GET as PULL } from "@/app/api/sync/v1/pull/route"
import { POST as PUSH } from "@/app/api/sync/v1/push/route"
import { params, req, sessionFrom, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let cookie: string
let soap: Product
let rice: Product
let rosaId: string

beforeAll(async () => {
  s = await setupTestServer()
  cookie = sessionFrom(await LOGIN(req("POST", "/api/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } })))
  const [cat] = await s.db.insert(categories).values({ org_id: s.ids.org, name: "Household" }).returning()
  const insertProduct = async (values: Partial<typeof products.$inferInsert>) => {
    const [p] = await s.db
      .insert(products)
      .values({ org_id: s.ids.org, category_id: cat.id, name: "x", selling_price: 0, cost_price: 0, unit_type: "QUANTITY", ...values })
      .returning()
    // Opening stock from the back office (no terminal)
    await s.db.insert(stockMovements).values({ id: randomUUID(), store_id: s.ids.store, created_by: s.ids.owner, created_at: new Date(), product_id: p.id, quantity_delta: 50, reason: "RESTOCK" })
    return { ...p, stock_level: 50, pos_id: "x", is_synced: true } as unknown as Product
  }
  soap = await insertProduct({ name: "Laundry Soap", selling_price: 25, cost_price: 18, barcode: "4800000000028" })
  rice = await insertProduct({ name: "Rice", selling_price: 52.5, cost_price: 45, unit_type: "WEIGHT" })
  const [rosa] = await s.db.insert(customers).values({ store_id: s.ids.store, full_name: "Aling Rosa", credit_limit: 1000 }).returning()
  rosaId = rosa.id
  await s.db.update(users).set({ pin_hash: "$2b$10$examplehashforthecashier000000000000000000000000000000" }).where(eq(users.id, s.ids.cashier))
  await s.db.insert(userStores).values({ user_id: s.ids.cashier, store_id: s.ids.store })
})
afterAll(() => s.close())

async function pairDevice(name = "Counter tablet") {
  const created = await CREATE_TERMINAL(req("POST", `/api/stores/${s.ids.store}/terminals`, { cookie, body: { name } }), params({ storeId: s.ids.store }))
  const { terminal } = await created.json()
  const { code } = await (await PAIRING_CODE(req("POST", `/api/terminals/${terminal.id}/pairing-code`, { cookie }), params({ terminalId: terminal.id }))).json()
  const paired = await (await PAIR(req("POST", "/api/devices/pair", { origin: null, body: { code } }))).json()
  return { terminalId: terminal.id as string, token: paired.token as string }
}

const push = (token: string, records: PushRecord[], protocol: number = SYNC_PROTOCOL_VERSION) =>
  PUSH(new Request("http://localhost/api/sync/v1/push", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ protocol, records }) }))
const pull = async (token: string, cursor = 0, limit?: number) => {
  const res = await PULL(new Request(`http://localhost/api/sync/v1/pull?cursor=${cursor}${limit ? `&limit=${limit}` : ""}`, { headers: { authorization: `Bearer ${token}` } }))
  return { status: res.status, body: (await res.json()) as PullResponse }
}

/** A terminal's records from the real builders, in creation order, ready to push */
function terminalDay(terminalId: string) {
  let seq = 0
  let ids = 0
  const now = new Date("2026-10-15T01:00:00.000Z")
  const ctx = () => ({ storeId: s.ids.store, terminalId, now, newId: () => randomUUID() + (ids++ ? "" : ""), nextSeq: () => ++seq, userId: s.ids.cashier, cashierId: s.ids.cashier })
  const out: PushRecord[] = []
  const add = (type: PushRecord["type"], data: unknown) => out.push({ type, data } as PushRecord)

  const opened = buildShiftOpen({ openingFund: 1000 }, { user: { id: s.ids.cashier, is_active: true }, openShift: null, counters: terminalCounters(null, 0) }, ctx())
  if (!opened.ok) throw new Error(opened.code)
  const shift: ShiftOpenRecord = opened.shift
  add("shift_open", shift)

  const productMap = new Map([soap, rice].map((p) => [p.id, p]))
  const transactions: TransactionRecord[] = []
  const items: TransactionItemRecord[] = []
  const sell = (request: Parameters<typeof buildSale>[0], balance = 0) => {
    const r = buildSale(request, { products: productMap, openShift: shift, customer: { id: rosaId, credit_limit: 1000, current_debt_balance: balance, credit_status: "ACTIVE" } }, { ...ctx(), nextInvoiceNumber: transactions.filter((t) => t.transaction_type === "SALE").length + 1 })
    if (!r.ok) throw new Error(r.code)
    add("transaction", r.transaction)
    r.items.forEach((i) => add("transaction_item", i))
    r.stockMovements.forEach((m) => add("stock_movement", m))
    if (r.ledgerEntry) add("credit_ledger_entry", r.ledgerEntry)
    transactions.push(r.transaction)
    items.push(...r.items)
    return r
  }
  const cashSale = sell({ lines: [{ productId: soap.id, quantity: 2 }, { productId: rice.id, quantity: 1.5 }], amountTendered: 200 }).transaction
  sell({ lines: [{ productId: soap.id, quantity: 8 }], paymentMethod: "STORE_CREDIT", referenceNumber: rosaId })

  const voided = buildVoid(
    { authorizedBy: s.ids.manager, reason: "Returned" },
    { openShift: shift, original: cashSale, items: items.filter((i) => i.transaction_id === cashSale.id), alreadyVoided: false },
    { ...ctx(), nextCreditNoteNumber: 1 }
  )
  if (!voided.ok) throw new Error(voided.code)
  add("transaction", voided.creditNote)
  voided.stockMovements.forEach((m) => add("stock_movement", m))
  add("audit_log", voided.auditLog)
  transactions.push(voided.creditNote)

  const paid = buildCreditPayment({ customerId: rosaId, amount: 50, paymentMethod: "CASH" }, { openShift: shift, customer: { id: rosaId, full_name: "Aling Rosa", current_debt_balance: 200 } }, ctx())
  if (!paid.ok) throw new Error(paid.code)
  add("credit_ledger_entry", paid.ledgerEntry)
  if (paid.cashMovement) add("cash_movement", paid.cashMovement)
  const out1 = buildCashMovement({ type: "CASH_OUT", amount: 20, reason: "Ice" }, { openShift: shift }, ctx())
  if (!out1.ok) throw new Error(out1.code)
  add("cash_movement", out1.movement)

  const cashMoves = out.filter((r) => r.type === "cash_movement").map((r) => r.data as never)
  const ledger = out.filter((r) => r.type === "credit_ledger_entry").map((r) => r.data as never)
  const closed = computeShiftClose({ actualCash: 1030 }, { shift, transactions, cashMovements: cashMoves, creditLedgerEntries: ledger, counters: terminalCounters(null, 0) }, ctx())
  if (!closed.ok) throw new Error(closed.code)
  add("shift_close", closed.close)
  const z = computeZReading({ transactions, shiftOpens: [shift], cashMovements: cashMoves, previous: null, openingGrandTotal: 0 }, { ...ctx(), userId: s.ids.manager })
  if (!z.ok) throw new Error(z.code)
  add("z_reading", z.reading)
  return { records: out, shift }
}

describe("push", () => {
  it("stores a whole day of real records, and a resend stores nothing twice", async () => {
    const device = await pairDevice()
    const { records } = terminalDay(device.terminalId)
    const res = await push(device.token, records)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accepted).toEqual(records.map((r) => r.data.device_seq))
    expect(body).toMatchObject({ duplicates: [], highest_seq: records.length })

    const again = await (await push(device.token, records)).json()
    expect(again).toMatchObject({ accepted: [], duplicates: records.map((r) => r.data.device_seq), highest_seq: records.length })

    // The pushed sales moved the store's stock: 50 - 2 - 8 + 2 (void) soap, 50 - 1.5 + 1.5 rice
    const { body: pulled } = await pull(device.token)
    const stock = Object.fromEntries(pulled.stock!.map((x) => [x.product_id, x.stock_level]))
    expect(stock[soap.id]).toBe(42)
    expect(stock[rice.id]).toBe(50)
    const balances = Object.fromEntries(pulled.balances!.map((x) => [x.customer_id, x.balance]))
    expect(balances[rosaId]).toBe(150) // 200 charged, 50 paid
  })

  it("refuses records of another terminal, foreign references, and clashing sequence numbers", async () => {
    const a = await pairDevice("A")
    const b = await pairDevice("B")
    const dayA = terminalDay(a.terminalId)
    const dayB = terminalDay(b.terminalId)

    // B pushes A's records
    let res = await push(b.token, dayA.records.slice(0, 3))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ code: "WRONG_TERMINAL" })

    // B's sale pointing at A's shift
    expect((await push(a.token, dayA.records.slice(0, 1))).status).toBe(200)
    const sale = dayB.records.find((r) => r.type === "transaction")!
    const hijacked = { ...sale, data: { ...sale.data, shift_id: dayA.shift.id } } as PushRecord
    res = await push(b.token, [dayB.records[0], hijacked])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ code: "UNKNOWN_REFERENCE", device_seq: hijacked.data.device_seq })

    // A product from another organization
    const [other] = await s.db.select().from(organizations).where(eq(organizations.name, "Another Business"))
    const [foreign] = await s.db.insert(products).values({ org_id: other.id, name: "Theirs", selling_price: 1, cost_price: 1, unit_type: "QUANTITY" }).returning()
    const item = dayA.records.find((r) => r.type === "transaction_item")!
    const saleA = dayA.records.find((r) => r.type === "transaction")!
    res = await push(a.token, [saleA, { ...item, data: { ...item.data, product_id: foreign.id } } as PushRecord])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ code: "UNKNOWN_REFERENCE" })

    // Same device_seq, different record (two devices numbering one terminal): nothing from the batch is kept
    const clash = { ...dayA.records[0], data: { ...dayA.records[0].data, id: randomUUID() } } as PushRecord
    res = await push(a.token, [clash, ...dayA.records.slice(1, 3)])
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatchObject({ code: "SYNC_CONFLICT", device_seq: 1 })
    const afterClash = await (await push(a.token, dayA.records.slice(0, 3))).json()
    expect(afterClash).toMatchObject({ duplicates: [1], accepted: [2, 3] })
  })

  it("refuses unpaired devices and other protocol versions", async () => {
    const device = await pairDevice("Soon unpaired")
    const { records } = terminalDay(device.terminalId)
    expect((await push(device.token, records.slice(0, 1), 99)).status).toBe(400)
    await UNPAIR(req("POST", `/api/terminals/${device.terminalId}/unpair`, { cookie }), params({ terminalId: device.terminalId }))
    expect((await push(device.token, records.slice(0, 1))).status).toBe(401)
    expect((await pull(device.token)).status).toBe(401)
  })
})

describe("pull", () => {
  it("sends the store's catalog, customers and users (PIN hashes, never emails or passwords)", async () => {
    const device = await pairDevice("Puller")
    const { body } = await pull(device.token)
    expect(body.changes.stores.map((x) => x.id)).toEqual([s.ids.store])
    expect(body.changes.terminals.map((x) => x.id)).toEqual([device.terminalId])
    expect(body.changes.products.map((x) => x.id)).toEqual(expect.arrayContaining([soap.id, rice.id]))
    expect(body.changes.customers.map((x) => x.id)).toEqual([rosaId])
    const cashier = body.changes.users.find((u) => u.id === s.ids.cashier)!
    expect(cashier).toMatchObject({ has_access: true, pin_hash: expect.stringMatching(/^\$2b\$/) })
    expect(JSON.stringify(body)).not.toMatch(/password|owner@example\.com/)
    // Users of other stores (the manager works only in the main store; the branch has none) and
    // inactive users never carry a PIN hash
    for (const u of body.changes.users) if (!u.has_access || !u.is_active) expect(u.pin_hash).toBeNull()
    expect(body.cursor).toBeGreaterThan(0)
    expect(body.has_more).toBe(false)

    // Nothing new: an empty page that still carries current stock and balances
    const again = await pull(device.token, body.cursor)
    expect(Object.values(again.body.changes).every((rows) => rows.length === 0)).toBe(true)
    expect(again.body.cursor).toBe(body.cursor)
    expect(again.body.stock).not.toBeNull()
  })

  it("sends exactly what changed since the cursor, including deletes and lost store access", async () => {
    const device = await pairDevice("Delta")
    const start = (await pull(device.token)).body.cursor
    await s.db.update(products).set({ selling_price: 26 }).where(eq(products.id, soap.id))
    await s.db.update(customers).set({ deleted_at: new Date() }).where(eq(customers.id, rosaId))
    await s.db.delete(userStores).where(eq(userStores.user_id, s.ids.cashier))

    const { body } = await pull(device.token, start)
    expect(body.changes.products).toEqual([expect.objectContaining({ id: soap.id, selling_price: 26 })])
    expect(body.changes.customers).toEqual([expect.objectContaining({ id: rosaId, deleted_at: expect.any(String) })])
    // Lost access: the user arrives as "no access", and without their PIN hash
    expect(body.changes.users).toEqual([expect.objectContaining({ id: s.ids.cashier, has_access: false, pin_hash: null })])

    await s.db.update(customers).set({ deleted_at: null }).where(eq(customers.id, rosaId))
    await s.db.insert(userStores).values({ user_id: s.ids.cashier, store_id: s.ids.store })
  })

  it("pages through every change exactly once, with totals on the last page only", async () => {
    const device = await pairDevice("Pager")
    const all = (await pull(device.token)).body
    const expected = Object.values(all.changes).flat().length
    let cursor = 0
    let seen = 0
    let pages = 0
    for (;;) {
      const { body } = await pull(device.token, cursor, 2)
      pages++
      seen += Object.values(body.changes).flat().length
      expect(body.cursor).toBeGreaterThanOrEqual(cursor)
      cursor = body.cursor
      if (!body.has_more) {
        expect(body.stock).not.toBeNull()
        break
      }
      expect(body.stock).toBeNull()
    }
    expect(seen).toBe(expected)
    expect(pages).toBeGreaterThan(2)
  })

  it("unblocks a blocked customer only when a pushed payment brings them back within the limit", async () => {
    const balanceNow = async (token: string) => (await pull(token)).body.balances!.find((b) => b.customer_id === rosaId)?.balance ?? 0
    const statusAfterPush = async (limit: (balanceAfterDay: number) => number) => {
      const device = await pairDevice(`Collector ${randomUUID().slice(0, 4)}`)
      const { records } = terminalDay(device.terminalId) // charges 200, then a 50 payment
      const afterDay = (await balanceNow(device.token)) + 200 - 50
      await s.db.update(customers).set({ credit_status: "BLOCKED", credit_limit: limit(afterDay) }).where(eq(customers.id, rosaId))
      const cursor = (await pull(device.token)).body.cursor
      expect((await push(device.token, records)).status).toBe(200)
      const [row] = await s.db.select().from(customers).where(eq(customers.id, rosaId))
      return { status: row.credit_status, changes: (await pull(device.token, cursor)).body.changes.customers }
    }

    const stillOver = await statusAfterPush((after) => after - 0.01)
    expect(stillOver.status).toBe("BLOCKED")

    const backWithin = await statusAfterPush((after) => after)
    expect(backWithin.status).toBe("ACTIVE")
    // The change syncs down to every terminal of the store
    expect(backWithin.changes).toEqual([expect.objectContaining({ id: rosaId, credit_status: "ACTIVE" })])
  })
})
