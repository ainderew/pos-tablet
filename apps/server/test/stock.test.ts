import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { products, stockMovements, stores, terminals } from "@pos/db"
import { GET as GET_STOCK } from "@/app/api/stores/[storeId]/stock/route"
import { GET as LIST_MOVEMENTS, POST as MOVE } from "@/app/api/stores/[storeId]/stock-movements/route"
import { createSession } from "@/lib/auth/session"
import { params, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let otherOrg = ""
const as: Record<"owner" | "manager" | "cashier", string> = { owner: "", manager: "", cashier: "" }

beforeAll(async () => {
  s = await setupTestServer()
  ;[{ org_id: otherOrg }] = await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore))
  const cookie = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
  as.owner = await cookie(s.ids.owner)
  as.manager = await cookie(s.ids.manager)
  as.cashier = await cookie(s.ids.cashier)
})
afterAll(() => s.close())

type Json = Record<string, any>
const json = async (res: Response) => (await res.json()) as Json

/** Products straight into the database: these tests are about stock, not the product routes */
const seedProduct = async (unit_type: "QUANTITY" | "WEIGHT", org_id = s.ids.org) => {
  const [p] = await s.db.insert(products).values({ org_id, name: `${unit_type} ${randomUUID().slice(0, 6)}`, selling_price: 10, cost_price: 8, unit_type }).returning()
  return p
}
const move = (cookie: string, storeId: string, body: unknown, origin?: string | null) =>
  MOVE(req("POST", `/api/stores/${storeId}/stock-movements`, { cookie, body, origin }), params({ storeId }))
const stock = (cookie: string, storeId: string, query = "") => GET_STOCK(req("GET", `/api/stores/${storeId}/stock${query}`, { cookie }), params({ storeId }))
const history = (cookie: string, storeId: string, query = "") =>
  LIST_MOVEMENTS(req("GET", `/api/stores/${storeId}/stock-movements${query}`, { cookie }), params({ storeId }))
const levelOf = async (storeId: string, productId: string) => (await json(await stock(as.owner, storeId, `?product_id=${productId}`))).stock[0].stock_level

describe("POST /api/stores/:storeId/stock-movements", () => {
  it("records a back-office restock with no terminal, and returns the new level", async () => {
    const p = await seedProduct("QUANTITY")
    const res = await move(as.manager, s.ids.store, { product_id: p.id, quantity_delta: 24, reason: "RESTOCK", note: "  Delivery from supplier " })
    expect(res.status).toBe(201)
    const { movement, stock_level } = await json(res)
    expect(stock_level).toBe(24)
    expect(movement).toMatchObject({
      store_id: s.ids.store,
      product_id: p.id,
      quantity_delta: 24,
      reason: "RESTOCK",
      note: "Delivery from supplier",
      terminal_id: null,
      device_seq: null,
      created_by: s.ids.manager,
      ref_id: null,
    })
    const again = await json(await move(as.manager, s.ids.store, { product_id: p.id, quantity_delta: -3, reason: "ADJUSTMENT", note: "" }))
    expect(again).toMatchObject({ stock_level: 21, movement: { quantity_delta: -3, note: null } })
  })

  it("sums weights exactly (0.7 - 0.4 = 0.3)", async () => {
    const rice = await seedProduct("WEIGHT")
    await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: 0.7, reason: "RESTOCK" })
    const res = await json(await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: -0.4, reason: "ADJUSTMENT" }))
    expect(res.stock_level).toBe(0.3)
    expect(0.7 - 0.4).not.toBe(0.3) // what adding them up in floating point would have given
    await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: 0.1, reason: "RESTOCK" })
    await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: 0.2, reason: "RESTOCK" })
    expect(await levelOf(s.ids.store, rice.id)).toBe(0.6)
    expect((await json(await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: 0.125, reason: "RESTOCK" }))).stock_level).toBe(0.725)
  })

  it("validates the movement", async () => {
    const box = await seedProduct("QUANTITY")
    const rice = await seedProduct("WEIGHT")
    const cases: Json[] = [
      { product_id: box.id, quantity_delta: 0, reason: "RESTOCK" },
      { product_id: box.id, quantity_delta: 1.5, reason: "RESTOCK" }, // QUANTITY: whole numbers
      { product_id: rice.id, quantity_delta: 0.0005, reason: "RESTOCK" }, // grams at most
      { product_id: box.id, quantity_delta: "5", reason: "RESTOCK" },
      { product_id: box.id, quantity_delta: 5, reason: "SALE" }, // terminals' reasons
      { product_id: box.id, quantity_delta: 5, reason: "VOID" },
      { product_id: box.id, quantity_delta: 5 },
      { product_id: "nope", quantity_delta: 5, reason: "RESTOCK" },
      { product_id: box.id, quantity_delta: 1e12, reason: "RESTOCK" },
    ]
    for (const body of cases) {
      const res = await move(as.manager, s.ids.store, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await json(res)).error.code).toBe("INVALID_INPUT")
    }
    expect((await move(as.manager, s.ids.store, { product_id: rice.id, quantity_delta: 1.25, reason: "RESTOCK" })).status).toBe(201)
    expect(await levelOf(s.ids.store, box.id)).toBe(0)
  })

  it("only moves the organization's active products, in stores the caller works in", async () => {
    const p = await seedProduct("QUANTITY")
    const theirs = await seedProduct("QUANTITY", otherOrg)
    const gone = await seedProduct("QUANTITY")
    await s.db.update(products).set({ deleted_at: new Date() }).where(eq(products.id, gone.id))
    const body = (product_id: string) => ({ product_id, quantity_delta: 5, reason: "RESTOCK" })

    expect((await move(as.manager, s.ids.store, body(theirs.id))).status).toBe(404)
    expect((await move(as.manager, s.ids.store, body(gone.id))).status).toBe(404)
    expect((await move(as.manager, s.ids.store, body(randomUUID()))).status).toBe(404)
    expect((await move(as.manager, s.ids.branch, body(p.id))).status).toBe(404) // not the manager's store
    expect((await move(as.owner, s.ids.foreignStore, body(p.id))).status).toBe(404)
    expect((await move(as.owner, s.ids.branch, body(p.id))).status).toBe(201)
    expect((await move(as.cashier, s.ids.store, body(p.id))).status).toBe(403)
    expect((await move(as.manager, s.ids.store, body(p.id), null)).status).toBe(403) // CSRF
    // Stock is per store
    expect(await levelOf(s.ids.branch, p.id)).toBe(5)
    expect(await levelOf(s.ids.store, p.id)).toBe(0)
  })
})

describe("GET /api/stores/:storeId/stock", () => {
  it("sums every movement in the store, terminals' included", async () => {
    const p = await seedProduct("QUANTITY")
    await move(as.manager, s.ids.store, { product_id: p.id, quantity_delta: 10, reason: "RESTOCK" })
    const [terminal] = await s.db.insert(terminals).values({ store_id: s.ids.store, name: "Counter" }).returning()
    await s.db.insert(stockMovements).values([
      { id: randomUUID(), store_id: s.ids.store, terminal_id: terminal.id, device_seq: 1, created_at: new Date(), product_id: p.id, quantity_delta: -2, reason: "SALE" },
      { id: randomUUID(), store_id: s.ids.store, terminal_id: terminal.id, device_seq: 2, created_at: new Date(), product_id: p.id, quantity_delta: 1, reason: "VOID" },
    ])
    const res = await stock(as.manager, s.ids.store, `?product_id=${p.id}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ stock: [{ product_id: p.id, stock_level: 9 }] })
  })

  it("lists every active product of the catalog, 0 where nothing moved", async () => {
    const still = await seedProduct("QUANTITY")
    const three = await seedProduct("QUANTITY")
    const seven = await seedProduct("QUANTITY")
    const gone = await seedProduct("WEIGHT")
    await move(as.owner, s.ids.branch, { product_id: three.id, quantity_delta: 3, reason: "RESTOCK" })
    await move(as.owner, s.ids.branch, { product_id: seven.id, quantity_delta: 7, reason: "RESTOCK" })
    await move(as.owner, s.ids.store, { product_id: three.id, quantity_delta: 100, reason: "RESTOCK" }) // another store
    await move(as.owner, s.ids.branch, { product_id: gone.id, quantity_delta: 2.5, reason: "RESTOCK" })
    await s.db.update(products).set({ deleted_at: new Date() }).where(eq(products.id, gone.id))

    const all = (await json(await stock(as.owner, s.ids.branch))).stock as Json[]
    // Each product gets its own sum (a sum matched to the wrong product would show here)
    expect(all).toContainEqual({ product_id: three.id, stock_level: 3 })
    expect(all).toContainEqual({ product_id: seven.id, stock_level: 7 })
    expect(all).toContainEqual({ product_id: still.id, stock_level: 0 })
    expect(all.map((r) => r.product_id)).not.toContain(gone.id)
    const withDeleted = (await json(await stock(as.owner, s.ids.branch, "?include_deleted=1"))).stock as Json[]
    expect(withDeleted).toContainEqual({ product_id: gone.id, stock_level: 2.5 })
    expect(await levelOf(s.ids.branch, gone.id)).toBe(2.5) // a deleted product's stock can still be looked up
    expect(all.every((r) => typeof r.stock_level === "number")).toBe(true)
  })

  it("is scoped to the caller's stores and organization", async () => {
    const theirs = await seedProduct("QUANTITY", otherOrg)
    expect((await stock(as.manager, s.ids.branch)).status).toBe(404)
    expect((await stock(as.owner, s.ids.foreignStore)).status).toBe(404)
    expect((await stock(as.owner, s.ids.store, `?product_id=${theirs.id}`)).status).toBe(404)
    expect((await stock(as.owner, s.ids.store, "?product_id=junk")).status).toBe(404)
    expect((await stock(as.cashier, s.ids.store)).status).toBe(403)
  })
})

describe("GET /api/stores/:storeId/stock-movements", () => {
  it("lists movements newest first, by product and with a limit", async () => {
    const p = await seedProduct("QUANTITY")
    const other = await seedProduct("QUANTITY")
    for (const quantity_delta of [5, 6, 7]) await move(as.manager, s.ids.store, { product_id: p.id, quantity_delta, reason: "RESTOCK" })
    await move(as.manager, s.ids.store, { product_id: other.id, quantity_delta: 1, reason: "RESTOCK" })

    const mine = (await json(await history(as.manager, s.ids.store, `?product_id=${p.id}`))).movements as Json[]
    expect(mine.map((m) => m.quantity_delta)).toEqual([7, 6, 5])
    const latest = (await json(await history(as.manager, s.ids.store, `?product_id=${p.id}&limit=2`))).movements as Json[]
    expect(latest.map((m) => m.quantity_delta)).toEqual([7, 6])
    const all = (await json(await history(as.manager, s.ids.store, "?limit=1"))).movements as Json[]
    expect(all).toMatchObject([{ product_id: other.id, quantity_delta: 1, created_by: s.ids.manager }])
  })

  it("validates the query and scope", async () => {
    for (const limit of ["0", "1001", "2.5", "ten"]) {
      expect((await history(as.manager, s.ids.store, `?limit=${limit}`)).status, limit).toBe(400)
    }
    expect((await history(as.manager, s.ids.branch)).status).toBe(404)
    expect((await history(as.owner, s.ids.foreignStore)).status).toBe(404)
    expect((await history(as.owner, s.ids.store, `?product_id=${randomUUID()}`)).status).toBe(404)
    expect((await history(as.cashier, s.ids.store)).status).toBe(403)
    expect((await LIST_MOVEMENTS(req("GET", `/api/stores/${s.ids.store}/stock-movements`), params({ storeId: s.ids.store }))).status).toBe(401)
  })

  it("never shows another store's movements", async () => {
    const p = await seedProduct("QUANTITY")
    await move(as.owner, s.ids.branch, { product_id: p.id, quantity_delta: 3, reason: "RESTOCK" })
    expect((await json(await history(as.owner, s.ids.store, `?product_id=${p.id}`))).movements).toEqual([])
    expect((await json(await history(as.owner, s.ids.branch, `?product_id=${p.id}`))).movements).toHaveLength(1)
  })
})

