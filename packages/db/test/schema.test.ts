import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../src/testing"
import { organizations, products, shiftOpens, stores, terminals, transactions, userStores, users } from "../src"

let t: Awaited<ReturnType<typeof createTestDb>>
let ids: { org: string; store: string; terminal: string; user: string }

beforeAll(async () => {
  t = await createTestDb()
  const [org] = await t.db.insert(organizations).values({ name: "General Store" }).returning()
  const [store] = await t.db.insert(stores).values({ org_id: org.id, name: "Main" }).returning()
  const [terminal] = await t.db.insert(terminals).values({ store_id: store.id, name: "Tablet 1" }).returning()
  const [user] = await t.db.insert(users).values({ org_id: org.id, full_name: "Ana", role: "CASHIER" }).returning()
  ids = { org: org.id, store: store.id, terminal: terminal.id, user: user.id }
})
afterAll(() => t.close())

const record = (seq: number) => ({ id: randomUUID(), store_id: ids.store, terminal_id: ids.terminal, device_seq: seq, created_at: new Date() })
const openShift = async (seq: number) => {
  const shift = { ...record(seq), user_id: ids.user, opening_fund: 1000, snapshot_z_counter: 0, snapshot_accumulated_total: 0 }
  await t.db.insert(shiftOpens).values(shift)
  return shift
}
const sale = (seq: number, shiftId: string, n: number) => ({
  ...record(seq),
  shift_id: shiftId,
  cashier_id: ids.user,
  invoice_number: `SI-${String(n).padStart(6, "0")}`,
  transaction_type: "SALE",
  status: "PAID",
  gross_sales: 0.1 + 0.2,
  vatable_sales: 0.27,
  vat_amount: 0.03,
  vat_exempt_sales: 0,
  zero_rated_sales: 0,
  total_discount: 0,
  net_sales: 0.3,
  pax_count: 1,
  senior_count: 0,
  payment_method: "CASH",
  change_amount: 0,
})

describe("schema", () => {
  it("gives server-owned rows a new version on every update", async () => {
    const [p] = await t.db
      .insert(products)
      .values({ org_id: ids.org, name: "Soap", selling_price: 25, cost_price: 18, unit_type: "QUANTITY" })
      .returning()
    const [after] = await t.db.update(products).set({ selling_price: 26 }).where(eq(products.id, p.id)).returning()
    expect(after.version).toBeGreaterThan(p.version)
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(p.updated_at.getTime())
    expect(after.selling_price).toBe(26)
  })

  it("bumps a user's version when their store access changes", async () => {
    const [before] = await t.db.select().from(users).where(eq(users.id, ids.user))
    await t.db.insert(userStores).values({ user_id: ids.user, store_id: ids.store })
    const [after] = await t.db.select().from(users).where(eq(users.id, ids.user))
    expect(after.version).toBeGreaterThan(before.version)
  })

  it("stores money exactly (numeric), returned as numbers", async () => {
    const shift = await openShift(1)
    const [row] = await t.db.insert(transactions).values(sale(2, shift.id, 1)).returning()
    expect(row.gross_sales).toBe(0.3)
    expect(row.net_sales).toBe(0.3)
  })

  it("never inserts a resent record twice", async () => {
    const shift = await openShift(10)
    const first = sale(11, shift.id, 2)
    await t.db.insert(transactions).values(first)
    const resent = await t.db.insert(transactions).values({ ...first, id: randomUUID() }).onConflictDoNothing().returning()
    expect(resent).toHaveLength(0)
    await expect(t.db.insert(transactions).values({ ...first, id: randomUUID(), device_seq: 12 })).rejects.toThrow() // same SI number
  })

  it("refuses to update or delete terminal records", async () => {
    const shift = await openShift(20)
    const row = sale(21, shift.id, 3)
    await t.db.insert(transactions).values(row)
    // Drizzle wraps the database error ("Failed query: ..."); the trigger's message is the cause
    const reason = (p: Promise<unknown>) => p.then(() => "no error", (e: { cause?: { message?: string } }) => e.cause?.message ?? "")
    expect(await reason(t.db.update(transactions).set({ net_sales: 0 }).where(eq(transactions.id, row.id)))).toMatch(/append-only/)
    expect(await reason(t.db.delete(transactions).where(eq(transactions.id, row.id)))).toMatch(/append-only/)
  })

  it("enforces enums, signs and per-organization barcodes", async () => {
    await expect(
      t.db.insert(products).values({ org_id: ids.org, name: "Bad", selling_price: 1, cost_price: 1, unit_type: "LITRE" })
    ).rejects.toThrow()
    await expect(
      t.db.insert(products).values({ org_id: ids.org, name: "Negative", selling_price: -1, cost_price: 1, unit_type: "QUANTITY" })
    ).rejects.toThrow()
    const values = { org_id: ids.org, name: "Coke", barcode: "4800000000011", selling_price: 20, cost_price: 15, unit_type: "QUANTITY" }
    const [first] = await t.db.insert(products).values(values).returning()
    await expect(t.db.insert(products).values(values)).rejects.toThrow()
    // A soft-deleted product frees its barcode
    await t.db.update(products).set({ deleted_at: new Date() }).where(eq(products.id, first.id))
    await expect(t.db.insert(products).values(values)).resolves.toBeDefined()
  })

  it("has the version sequence and the triggers installed", async () => {
    const triggers = await t.db.execute(sql`select count(*)::int as n from information_schema.triggers where trigger_name like '%append_only'`)
    expect((triggers.rows[0] as { n: number }).n).toBe(9 * 2) // UPDATE and DELETE rows per table
  })
})
