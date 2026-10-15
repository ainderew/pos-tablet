import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { creditLedger, customers, shiftOpens, stores, terminals, transactions, users } from "@pos/db"
import { GET as GET_CUSTOMER, PATCH as PATCH_CUSTOMER, DELETE as DELETE_CUSTOMER } from "@/app/api/customers/[id]/route"
import { GET as LEDGER } from "@/app/api/customers/[id]/ledger/route"
import { POST as PAY } from "@/app/api/customers/[id]/payments/route"
import { GET as LIST_CUSTOMERS, POST as CREATE_CUSTOMER } from "@/app/api/stores/[storeId]/customers/route"
import { createSession } from "@/lib/auth/session"
import { params, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let owner: string // signed-in cookies
let manager: string // works in Main only
let cashier: string
let foreignOwner: string // another organization
let terminalId: string
let shiftId: string

const cookieFor = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`

beforeAll(async () => {
  s = await setupTestServer()
  owner = await cookieFor(s.ids.owner)
  manager = await cookieFor(s.ids.manager)
  cashier = await cookieFor(s.ids.cashier)
  const [foreign] = await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore))
  const [other] = await s.db.insert(users).values({ org_id: foreign.org_id, full_name: "Other Owner", role: "OWNER" }).returning()
  foreignOwner = await cookieFor(other.id)
  const [terminal] = await s.db.insert(terminals).values({ store_id: s.ids.store, name: "Counter" }).returning()
  terminalId = terminal.id
  shiftId = randomUUID()
  await s.db.insert(shiftOpens).values({ id: shiftId, store_id: s.ids.store, terminal_id: terminalId, device_seq: 1, created_at: new Date(), user_id: s.ids.cashier, opening_fund: 0, snapshot_z_counter: 0, snapshot_accumulated_total: 0 })
})
afterAll(() => s.close())

// ---- request helpers
const list = (cookie: string, storeId = s.ids.store, query = "") => LIST_CUSTOMERS(req("GET", `/api/stores/${storeId}/customers${query}`, { cookie }), params({ storeId }))
const create = (cookie: string, body: unknown, storeId = s.ids.store) => CREATE_CUSTOMER(req("POST", `/api/stores/${storeId}/customers`, { cookie, body }), params({ storeId }))
const get = (cookie: string, id: string) => GET_CUSTOMER(req("GET", `/api/customers/${id}`, { cookie }), params({ id }))
const patch = (cookie: string, id: string, body: unknown) => PATCH_CUSTOMER(req("PATCH", `/api/customers/${id}`, { cookie, body }), params({ id }))
const remove = (cookie: string, id: string) => DELETE_CUSTOMER(req("DELETE", `/api/customers/${id}`, { cookie }), params({ id }))
const ledger = (cookie: string, id: string) => LEDGER(req("GET", `/api/customers/${id}/ledger`, { cookie }), params({ id }))
const pay = (cookie: string, id: string, body: unknown) => PAY(req("POST", `/api/customers/${id}/payments`, { cookie, body }), params({ id }))

// ---- seeding
let seq = 1
let invoice = 0
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000 + seq * 1000)

async function newCustomer(values: Partial<typeof customers.$inferInsert> = {}) {
  const [c] = await s.db
    .insert(customers)
    .values({ store_id: s.ids.store, full_name: `Customer ${randomUUID().slice(0, 8)}`, credit_limit: 1000, ...values })
    .returning()
  return c
}

/** A store-credit sale synced from the terminal: the sale and its CHARGE entry */
async function chargeSale(customerId: string, amount: number) {
  const txId = randomUUID()
  const number = `SI-${String(++invoice).padStart(6, "0")}`
  await s.db.insert(transactions).values({
    id: txId, store_id: s.ids.store, terminal_id: terminalId, device_seq: ++seq, created_at: hourAgo(), shift_id: shiftId,
    invoice_number: number, transaction_type: "SALE", status: "PAID", gross_sales: amount, vatable_sales: 0, vat_amount: 0,
    vat_exempt_sales: amount, zero_rated_sales: 0, total_discount: 0, net_sales: amount, pax_count: 1, senior_count: 0,
    payment_method: "STORE_CREDIT", change_amount: 0,
  })
  await ledgerEntry(customerId, "CHARGE", amount, { transaction_id: txId })
  return number
}

/** A ledger entry synced from the terminal (terminal_id and device_seq set) */
async function ledgerEntry(customerId: string, entry_type: "CHARGE" | "PAYMENT" | "ADJUSTMENT", amount: number, extra: Partial<typeof creditLedger.$inferInsert> = {}) {
  await s.db.insert(creditLedger).values({
    id: randomUUID(), store_id: s.ids.store, terminal_id: terminalId, device_seq: ++seq, created_at: hourAgo(), shift_id: shiftId,
    customer_id: customerId, entry_type, amount, running_balance: 0, ...extra,
  })
}

const json = async (res: Response) => (await res.json()) as Record<string, any>

describe("creating and listing customers", () => {
  it("creates a customer in a store, rounding the credit limit to centavos", async () => {
    const res = await create(owner, { full_name: "  Aling Nena ", phone_number: " 0917 123 4567 ", email: "", address: "Purok 3", credit_limit: 1500.555 })
    expect(res.status).toBe(201)
    const { customer } = await json(res)
    expect(customer).toMatchObject({
      store_id: s.ids.store, full_name: "Aling Nena", phone_number: "0917 123 4567", email: null, address: "Purok 3",
      credit_limit: 1500.56, credit_status: "ACTIVE", balance: 0, deleted_at: null,
    })
    expect((await json(await get(owner, customer.id))).customer).toMatchObject({ id: customer.id, balance: 0 })
  })

  it("defaults the credit limit to 0", async () => {
    const { customer } = await json(await create(manager, { full_name: "Mang Tomas" }))
    expect(customer).toMatchObject({ credit_limit: 0, phone_number: null, address: null })
  })

  it("validates the body", async () => {
    for (const body of [
      {},
      { full_name: "   " },
      { full_name: "A", credit_limit: -1 },
      { full_name: "A", credit_limit: "100" },
      { full_name: "A", email: "not an email" },
      { full_name: "A".repeat(121) },
    ]) {
      const res = await create(owner, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await json(res)).error.code).toBe("INVALID_INPUT")
    }
  })

  it("lists a store's customers by name with balances, searching name, phone and email", async () => {
    const storeId = (await s.db.insert(stores).values({ org_id: s.ids.org, name: "Search store" }).returning())[0].id
    const mk = (full_name: string, values: Partial<typeof customers.$inferInsert> = {}) => newCustomer({ store_id: storeId, full_name, ...values })
    const zed = await mk("zed Cruz", { phone_number: "0918 555 0000" })
    const ana = await mk("Ana Reyes", { email: "ana@example.com", credit_status: "BLOCKED" })
    const juice = await mk("100% Juice Stand")
    await s.db.insert(creditLedger).values({ id: randomUUID(), store_id: storeId, created_by: s.ids.owner, created_at: new Date(), customer_id: zed.id, entry_type: "CHARGE", amount: 12.5, running_balance: 12.5 })

    const all = (await json(await list(owner, storeId))).customers
    expect(all.map((c: { full_name: string }) => c.full_name)).toEqual(["100% Juice Stand", "Ana Reyes", "zed Cruz"])
    expect(all.find((c: { id: string }) => c.id === zed.id).balance).toBe(12.5)
    expect(all.find((c: { id: string }) => c.id === ana.id).balance).toBe(0)

    const names = async (query: string) => (await json(await list(owner, storeId, query))).customers.map((c: { id: string }) => c.id)
    expect(await names("?search=CRUZ")).toEqual([zed.id])
    expect(await names("?search=555")).toEqual([zed.id])
    expect(await names("?search=ANA%40example")).toEqual([ana.id])
    expect(await names("?search=%25")).toEqual([juice.id]) // a literal %, not a wildcard
    expect(await names("?status=BLOCKED")).toEqual([ana.id])
    expect(await names("?status=BLOCKED&search=zed")).toEqual([])

    const bad = await list(owner, storeId, "?status=FROZEN")
    expect(bad.status).toBe(400)
    expect((await json(bad)).error.code).toBe("INVALID_INPUT")
  })

  it("leaves deleted customers out unless include_deleted=1", async () => {
    const gone = await newCustomer({ deleted_at: new Date() })
    const ids = async (query = "") => (await json(await list(owner, s.ids.store, query))).customers.map((c: { id: string }) => c.id)
    expect(await ids()).not.toContain(gone.id)
    expect(await ids("?include_deleted=1")).toContain(gone.id)
  })
})

describe("scope", () => {
  it("needs a signed-in manager, owner or admin, and a same-origin request for writes", async () => {
    expect((await list("pos_session=nope")).status).toBe(401)
    expect((await list(cashier)).status).toBe(403)
    const crossSite = await CREATE_CUSTOMER(req("POST", `/api/stores/${s.ids.store}/customers`, { cookie: owner, origin: "https://evil.example", body: { full_name: "X" } }), params({ storeId: s.ids.store }))
    expect(crossSite.status).toBe(403)
  })

  it("answers 404 for stores and customers outside the caller's organization or stores", async () => {
    const branchCustomer = await newCustomer({ store_id: s.ids.branch })
    const mainCustomer = await newCustomer()
    // A manager of Main can't reach the branch
    expect((await list(manager, s.ids.branch)).status).toBe(404)
    expect((await create(manager, { full_name: "X" }, s.ids.branch)).status).toBe(404)
    for (const res of [
      await get(manager, branchCustomer.id),
      await patch(manager, branchCustomer.id, { full_name: "X" }),
      await remove(manager, branchCustomer.id),
      await ledger(manager, branchCustomer.id),
      await pay(manager, branchCustomer.id, { amount: 1, payment_method: "CASH" }),
    ]) {
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("NOT_FOUND")
    }
    expect((await get(owner, branchCustomer.id)).status).toBe(200)
    expect((await get(manager, mainCustomer.id)).status).toBe(200)

    // Another organization sees nothing of ours, and we nothing of theirs
    expect((await list(foreignOwner, s.ids.store)).status).toBe(404)
    expect((await get(foreignOwner, mainCustomer.id)).status).toBe(404)
    expect((await pay(foreignOwner, mainCustomer.id, { amount: 1, payment_method: "CASH" })).status).toBe(404)
    expect((await list(owner, s.ids.foreignStore)).status).toBe(404)
    const foreignCustomer = await newCustomer({ store_id: s.ids.foreignStore })
    expect((await get(owner, foreignCustomer.id)).status).toBe(404)
    expect((await get(owner, "not-a-uuid")).status).toBe(404)
    expect((await get(owner, randomUUID())).status).toBe(404)
  })
})

describe("editing customers", () => {
  it("updates any field, clears optional ones with null, and bumps the version", async () => {
    const c = await newCustomer({ phone_number: "0917", email: "old@example.com" })
    const res = await patch(manager, c.id, { full_name: "Renamed", phone_number: null, email: "new@example.com", credit_limit: 250.004, credit_status: "OVERDUE" })
    expect(res.status).toBe(200)
    const { customer } = await json(res)
    expect(customer).toMatchObject({ id: c.id, full_name: "Renamed", phone_number: null, email: "new@example.com", credit_limit: 250, credit_status: "OVERDUE", balance: 0 })
    expect(customer.version).toBeGreaterThan(c.version)
    // Fields left out stay as they were
    expect((await json(await patch(manager, c.id, { address: "Somewhere" }))).customer).toMatchObject({ full_name: "Renamed", address: "Somewhere" })
  })

  it("refuses invalid changes", async () => {
    const c = await newCustomer()
    for (const body of [{}, { credit_status: "FROZEN" }, { credit_limit: -5 }, { full_name: "" }, { full_name: null }]) {
      const res = await patch(owner, c.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await json(res)).error.code).toBe("INVALID_INPUT")
    }
  })
})

describe("balances and payments", () => {
  it("sums charges and payments exactly to the centavo (30.30 − 10.10 = 20.20)", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 30.3)
    expect((await json(await get(owner, c.id))).customer.balance).toBe(30.3)

    const res = await pay(owner, c.id, { amount: 10.1, payment_method: "GCASH", reference_number: " REF-123 ", notes: "first installment" })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.balance).toBe(20.2)
    expect(body.customer).toMatchObject({ id: c.id, balance: 20.2 })
    expect(body.entry).toMatchObject({
      customer_id: c.id, store_id: s.ids.store, entry_type: "PAYMENT", amount: 10.1, running_balance: 20.2,
      terminal_id: null, device_seq: null, shift_id: null, transaction_id: null, created_by: s.ids.owner,
      payment_method: "GCASH", reference_number: "REF-123", notes: "Payment via GCASH (REF-123). first installment",
    })
    expect(body.entry.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await json(await get(owner, c.id))).customer.balance).toBe(20.2)
  })

  it("adds up amounts that floating point would not (0.10 + 0.20 = 0.30)", async () => {
    const c = await newCustomer()
    await ledgerEntry(c.id, "CHARGE", 0.1)
    await ledgerEntry(c.id, "CHARGE", 0.2)
    expect((await json(await get(owner, c.id))).customer.balance).toBe(0.3)
    expect((await json(await pay(owner, c.id, { amount: 0.3, payment_method: "CASH" }))).balance).toBe(0)
  })

  it("deducts terminal payments and adjustments", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 500)
    await ledgerEntry(c.id, "PAYMENT", 120.25, { payment_method: "CASH" })
    await ledgerEntry(c.id, "ADJUSTMENT", 79.75)
    expect((await json(await get(owner, c.id))).customer.balance).toBe(300)
    const listed = (await json(await list(owner))).customers.find((x: { id: string }) => x.id === c.id)
    expect(listed.balance).toBe(300)
  })

  it("words the note like POS-bir when there's no reference or note", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 50)
    const { entry } = await json(await pay(manager, c.id, { amount: 50, payment_method: "CASH" }))
    expect(entry).toMatchObject({ notes: "Payment via CASH . ", reference_number: null, created_by: s.ids.manager })
  })

  it("rounds the amount to centavos and refuses amounts that aren't positive", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 100)
    expect((await json(await pay(owner, c.id, { amount: 10.005, payment_method: "MAYA" }))).entry.amount).toBe(10.01)
    for (const body of [
      { amount: 0, payment_method: "CASH" },
      { amount: -10, payment_method: "CASH" }, // POS-bir accepted this and increased the debt
      { amount: 0.004, payment_method: "CASH" },
      { amount: "10", payment_method: "CASH" },
      { amount: 10, payment_method: "STORE_CREDIT" },
      { amount: 10, payment_method: "BITCOIN" },
      { amount: 10 },
      { payment_method: "CASH" },
    ]) {
      const res = await pay(owner, c.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await json(res)).error.code).toBe("INVALID_INPUT")
    }
    expect((await json(await get(owner, c.id))).customer.balance).toBe(89.99)
  })

  it("lets a customer overpay (the store then owes them)", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 20)
    const body = await json(await pay(owner, c.id, { amount: 25, payment_method: "CARD" }))
    expect(body).toMatchObject({ balance: -5, entry: { running_balance: -5 } })
  })

  it("unblocks a BLOCKED customer once the balance is back within the limit (POS-bir's rule)", async () => {
    const c = await newCustomer({ credit_limit: 100, credit_status: "BLOCKED" })
    await chargeSale(c.id, 150)
    const stillOver = await json(await pay(owner, c.id, { amount: 40, payment_method: "CASH" }))
    expect(stillOver).toMatchObject({ balance: 110, customer: { credit_status: "BLOCKED" } })
    const atLimit = await json(await pay(owner, c.id, { amount: 10, payment_method: "CASH" }))
    expect(atLimit).toMatchObject({ balance: 100, customer: { credit_status: "ACTIVE", balance: 100 } })
    const [row] = await s.db.select().from(customers).where(eq(customers.id, c.id))
    expect(row.credit_status).toBe("ACTIVE")
    expect(row.version).toBeGreaterThan(c.version) // syncs down to the terminals
  })

  it("leaves OVERDUE customers' status alone", async () => {
    const c = await newCustomer({ credit_limit: 100, credit_status: "OVERDUE" })
    await chargeSale(c.id, 50)
    expect((await json(await pay(owner, c.id, { amount: 50, payment_method: "CASH" }))).customer.credit_status).toBe("OVERDUE")
  })
})

describe("ledger", () => {
  it("lists entries oldest first, with the sale's invoice number when there is one", async () => {
    const c = await newCustomer()
    const first = await chargeSale(c.id, 30.3)
    await ledgerEntry(c.id, "ADJUSTMENT", 0.3)
    const second = await chargeSale(c.id, 15)
    await pay(owner, c.id, { amount: 10, payment_method: "CASH", reference_number: "OR-9" })

    const res = await ledger(manager, c.id)
    expect(res.status).toBe(200)
    const { entries } = await json(res)
    expect(entries.map((e: { entry_type: string; invoice_number: string | null; amount: number }) => [e.entry_type, e.invoice_number, e.amount])).toEqual([
      ["CHARGE", first, 30.3],
      ["ADJUSTMENT", null, 0.3],
      ["CHARGE", second, 15],
      ["PAYMENT", null, 10],
    ])
    expect(entries[3]).toMatchObject({ running_balance: 35, reference_number: "OR-9", terminal_id: null })
    // Only this customer's entries
    const other = await newCustomer()
    expect((await json(await ledger(owner, other.id))).entries).toEqual([])
  })
})

describe("deleting customers", () => {
  it("refuses while the balance isn't 0, either way", async () => {
    const owes = await newCustomer()
    await chargeSale(owes.id, 42.5)
    const res = await remove(owner, owes.id)
    expect(res.status).toBe(409)
    expect((await json(res)).error).toMatchObject({ code: "HAS_BALANCE", balance: 42.5 })

    const owed = await newCustomer()
    await chargeSale(owed.id, 10)
    await pay(owner, owed.id, { amount: 12, payment_method: "CASH" })
    expect((await json(await remove(owner, owed.id))).error).toMatchObject({ code: "HAS_BALANCE", balance: -2 })
  })

  it("soft-deletes a settled customer, who then drops out of the routes", async () => {
    const c = await newCustomer()
    await chargeSale(c.id, 99.99)
    await pay(owner, c.id, { amount: 99.99, payment_method: "CASH" })
    const res = await remove(manager, c.id)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })

    const [row] = await s.db.select().from(customers).where(eq(customers.id, c.id))
    expect(row.deleted_at).toBeInstanceOf(Date)
    expect(row.version).toBeGreaterThan(c.version)
    // The ledger is untouched (append-only)
    expect(await s.db.select().from(creditLedger).where(eq(creditLedger.customer_id, c.id))).toHaveLength(2)
    for (const after of [await get(owner, c.id), await remove(owner, c.id), await patch(owner, c.id, { full_name: "X" }), await pay(owner, c.id, { amount: 1, payment_method: "CASH" })]) {
      expect(after.status).toBe(404)
    }
  })

  it("deletes a customer who never bought on credit", async () => {
    const c = await newCustomer()
    expect((await remove(owner, c.id)).status).toBe(200)
  })
})

describe("deleted stores", () => {
  it("keeps a customer whose store was deleted out of reach", async () => {
    const [closed] = await s.db.insert(stores).values({ org_id: s.ids.org, name: "Closed", deleted_at: new Date() }).returning()
    const c = await newCustomer({ store_id: closed.id })
    expect((await get(owner, c.id)).status).toBe(404)
    expect((await list(owner, closed.id)).status).toBe(404)
  })
})
