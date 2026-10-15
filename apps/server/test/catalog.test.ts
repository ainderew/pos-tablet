import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { categories, stores, users } from "@pos/db"
import { DELETE as DELETE_CATEGORY, PATCH as PATCH_CATEGORY } from "@/app/api/categories/[id]/route"
import { GET as LIST_CATEGORIES, POST as CREATE_CATEGORY } from "@/app/api/categories/route"
import { DELETE as DELETE_PRODUCT, GET as GET_PRODUCT, PATCH as PATCH_PRODUCT } from "@/app/api/products/[id]/route"
import { GET as LIST_PRODUCTS, POST as CREATE_PRODUCT } from "@/app/api/products/route"
import { POST as MOVE_STOCK } from "@/app/api/stores/[storeId]/stock-movements/route"
import { createSession } from "@/lib/auth/session"
import { params, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let otherOrg = ""
const as: Record<"owner" | "manager" | "cashier" | "outsider", string> = { owner: "", manager: "", cashier: "", outsider: "" }

beforeAll(async () => {
  s = await setupTestServer()
  ;[{ org_id: otherOrg }] = await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore))
  const [outsider] = await s.db.insert(users).values({ org_id: otherOrg, full_name: "Otto Outsider", role: "OWNER", email: "otto@example.com" }).returning()
  const cookie = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
  as.owner = await cookie(s.ids.owner)
  as.manager = await cookie(s.ids.manager)
  as.cashier = await cookie(s.ids.cashier) // can't sign in; a session made for one anyway gets nothing
  as.outsider = await cookie(outsider.id)
})
afterAll(() => s.close())

type Json = Record<string, any>
const json = async (res: Response) => (await res.json()) as Json

const listCategories = (cookie: string, query = "") => LIST_CATEGORIES(req("GET", `/api/categories${query}`, { cookie }))
const createCategory = (cookie: string, body: unknown) => CREATE_CATEGORY(req("POST", "/api/categories", { cookie, body }))
const patchCategory = (cookie: string, id: string, body: unknown) => PATCH_CATEGORY(req("PATCH", `/api/categories/${id}`, { cookie, body }), params({ id }))
const deleteCategory = (cookie: string, id: string) => DELETE_CATEGORY(req("DELETE", `/api/categories/${id}`, { cookie }), params({ id }))

const listProducts = (cookie: string, query = "") => LIST_PRODUCTS(req("GET", `/api/products${query}`, { cookie }))
const createProduct = (cookie: string, body: unknown) => CREATE_PRODUCT(req("POST", "/api/products", { cookie, body }))
const getProduct = (cookie: string, id: string, query = "") => GET_PRODUCT(req("GET", `/api/products/${id}${query}`, { cookie }), params({ id }))
const patchProduct = (cookie: string, id: string, body: unknown) => PATCH_PRODUCT(req("PATCH", `/api/products/${id}`, { cookie, body }), params({ id }))
const deleteProduct = (cookie: string, id: string) => DELETE_PRODUCT(req("DELETE", `/api/products/${id}`, { cookie }), params({ id }))

const newCategory = async (name: string, cookie = as.manager) => (await json(await createCategory(cookie, { name }))).category as Json
const product = (overrides: Json = {}) => ({ name: `Item ${randomUUID().slice(0, 8)}`, selling_price: 25, cost_price: 18.5, unit_type: "QUANTITY", ...overrides })
const newProduct = async (overrides: Json = {}, cookie = as.manager) => {
  const res = await createProduct(cookie, product(overrides))
  expect(res.status).toBe(201)
  return (await json(res)).product as Json
}
const productNames = async (res: Response) => ((await json(res)).products as Json[]).map((p) => p.name)

describe("categories", () => {
  it("creates categories with unique names per organization, ignoring case", async () => {
    const res = await createCategory(as.manager, { name: "  Beverages " })
    expect(res.status).toBe(201)
    expect((await json(res)).category).toMatchObject({ name: "Beverages", org_id: s.ids.org, product_count: 0, deleted_at: null })

    const dup = await createCategory(as.owner, { name: "BEVERAGES" })
    expect(dup.status).toBe(409)
    expect((await json(dup)).error.code).toBe("DUPLICATE_NAME")
    expect((await createCategory(as.outsider, { name: "Beverages" })).status).toBe(201) // another organization
    expect((await createCategory(as.manager, { name: "" })).status).toBe(400)
    expect((await createCategory(as.manager, { name: "x".repeat(81) })).status).toBe(400)
  })

  it("lists the organization's categories with their active product count", async () => {
    // Different counts per category, so a count matched to the wrong category would show
    const beverages = (await json(await listCategories(as.manager))).categories[0] as Json
    const snacks = await newCategory("Snacks")
    await newProduct({ category_id: snacks.id })
    await newProduct({ category_id: snacks.id })
    await newProduct({ category_id: beverages.id })
    const deleted = await newProduct({ category_id: snacks.id })
    await deleteProduct(as.manager, deleted.id)

    const { categories: rows } = await json(await listCategories(as.manager))
    expect(rows.map((c: Json) => [c.name, c.product_count])).toEqual([
      ["Beverages", 1],
      ["Snacks", 2],
    ])
    expect((await json(await listCategories(as.manager, "?search=SNA"))).categories.map((c: Json) => c.name)).toEqual(["Snacks"])
    expect((await json(await listCategories(as.outsider))).categories.map((c: Json) => c.name)).toEqual(["Beverages"])
  })

  it("renames a category and bumps its version", async () => {
    const cat = await newCategory("Frozen")
    const res = await patchCategory(as.manager, cat.id, { name: "Frozen goods" })
    expect(res.status).toBe(200)
    const { category } = await json(res)
    expect(category).toMatchObject({ id: cat.id, name: "Frozen goods", product_count: 0 })
    expect(category.version).toBeGreaterThan(cat.version)

    expect((await patchCategory(as.manager, cat.id, { name: "FROZEN GOODS" })).status).toBe(200) // its own name, new case
    const dup = await patchCategory(as.manager, cat.id, { name: "beverages" })
    expect(dup.status).toBe(409)
    expect((await json(dup)).error.code).toBe("DUPLICATE_NAME")
    expect((await patchCategory(as.manager, cat.id, { name: " " })).status).toBe(400)
  })

  it("refuses to delete a category active products use, then soft-deletes it", async () => {
    const cat = await newCategory("Household")
    const item = await newProduct({ category_id: cat.id })
    const inUse = await deleteCategory(as.manager, cat.id)
    expect(inUse.status).toBe(409)
    expect((await json(inUse)).error.code).toBe("CATEGORY_IN_USE")

    await patchProduct(as.manager, item.id, { category_id: null })
    expect(await json(await deleteCategory(as.manager, cat.id))).toEqual({ ok: true })
    const [row] = await s.db.select().from(categories).where(eq(categories.id, cat.id))
    expect(row.deleted_at).not.toBeNull() // still there, so the delete syncs down
    expect(row.version).toBeGreaterThan(cat.version)

    const names = async (query = "") => (await json(await listCategories(as.manager, query))).categories.map((c: Json) => c.name)
    expect(await names()).not.toContain("Household")
    expect(await names("?include_deleted=1")).toContain("Household")
    expect((await deleteCategory(as.manager, cat.id)).status).toBe(404)
    expect((await patchCategory(as.manager, cat.id, { name: "Back" })).status).toBe(404)
    expect((await createCategory(as.manager, { name: "household" })).status).toBe(201) // the name is free again
    // A product can't be put into a deleted category
    const res = await createProduct(as.manager, product({ category_id: cat.id }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.issues).toEqual([{ path: "category_id", message: "Category not found" }])
  })

  it("keeps other organizations' categories out of reach", async () => {
    const theirs = (await json(await listCategories(as.outsider))).categories[0] as Json
    expect((await patchCategory(as.manager, theirs.id, { name: "Ours" })).status).toBe(404)
    expect((await deleteCategory(as.owner, theirs.id)).status).toBe(404)
    expect((await deleteCategory(as.owner, "not-a-uuid")).status).toBe(404)
    expect((await createProduct(as.manager, product({ category_id: theirs.id }))).status).toBe(400)
  })

  it("is for managers", async () => {
    expect((await listCategories(as.cashier)).status).toBe(403)
    expect((await createCategory(as.cashier, { name: "Cashier's" })).status).toBe(403)
    expect((await LIST_CATEGORIES(req("GET", "/api/categories"))).status).toBe(401)
    expect((await CREATE_CATEGORY(req("POST", "/api/categories", { cookie: as.manager, body: { name: "CSRF" }, origin: null }))).status).toBe(403)
  })
})

describe("products", () => {
  it("creates a product with POS-bir's defaults", async () => {
    const res = await createProduct(as.manager, { name: " Coke 1.5L ", barcode: "", selling_price: 85, cost_price: 70.25, unit_type: "QUANTITY", category_id: "" })
    expect(res.status).toBe(201)
    expect((await json(res)).product).toMatchObject({
      org_id: s.ids.org,
      name: "Coke 1.5L",
      barcode: null,
      selling_price: 85,
      cost_price: 70.25,
      unit_type: "QUANTITY",
      tax_category: "VATABLE",
      supplier_type: "WHOLESALER",
      category_id: null,
      wholesale_price: null,
      wholesale_threshold: 0,
      low_stock_threshold: 0,
      notify_low_stock: false,
      is_promo: false,
      promo_price: null,
      deleted_at: null,
    })
  })

  it("saves every field", async () => {
    const cat = await newCategory("Rice")
    const p = await newProduct({
      name: "Dinorado rice",
      barcode: "4800000000017",
      unit_type: "WEIGHT",
      selling_price: 62.5,
      cost_price: 55,
      tax_category: "VAT_EXEMPT",
      supplier_type: "WET_MARKET",
      category_id: cat.id,
      wholesale_price: 58,
      wholesale_threshold: 25,
      low_stock_threshold: 10,
      notify_low_stock: true,
      is_promo: true,
      promo_price: 60,
    })
    expect(p).toMatchObject({ unit_type: "WEIGHT", tax_category: "VAT_EXEMPT", supplier_type: "WET_MARKET", category_id: cat.id, wholesale_price: 58, wholesale_threshold: 25, promo_price: 60 })
  })

  it("validates prices, units and the wholesale pair", async () => {
    const cases: [Json, string][] = [
      [{ selling_price: -1 }, "selling_price"],
      [{ cost_price: 1.234 }, "cost_price"],
      [{ selling_price: "25" }, "selling_price"],
      [{ unit_type: "KG" }, "unit_type"],
      [{ tax_category: "VAT" }, "tax_category"],
      [{ supplier_type: "MALL" }, "supplier_type"],
      [{ name: "" }, "name"],
      [{ wholesale_price: 20 }, "wholesale_threshold"],
      [{ wholesale_threshold: 12 }, "wholesale_price"],
      [{ wholesale_price: 0, wholesale_threshold: 12 }, "wholesale_price"],
      [{ low_stock_threshold: 2.5 }, "low_stock_threshold"],
      [{ promo_price: -5 }, "promo_price"],
      [{ category_id: "nope" }, "category_id"],
    ]
    for (const [overrides, path] of cases) {
      const res = await createProduct(as.manager, product(overrides))
      expect(res.status, JSON.stringify(overrides)).toBe(400)
      const { error } = await json(res)
      expect(error.code).toBe("INVALID_INPUT")
      expect(error.issues.map((i: Json) => i.path)).toContain(path)
    }
    const { selling_price, ...noPrice } = product()
    expect(selling_price).toBe(25)
    expect((await createProduct(as.manager, noPrice)).status).toBe(400)
  })

  it("stores POS-bir's 'no wholesale' (price 0, threshold 0) as not set", async () => {
    const p = await newProduct({ wholesale_price: 0, wholesale_threshold: 0, promo_price: "" })
    expect(p).toMatchObject({ wholesale_price: null, wholesale_threshold: 0, promo_price: null })
  })

  it("keeps barcodes unique among the organization's active products", async () => {
    const first = await newProduct({ barcode: "4801234567890" })
    const dup = await createProduct(as.owner, product({ barcode: "4801234567890" }))
    expect(dup.status).toBe(409)
    expect((await json(dup)).error.code).toBe("DUPLICATE_BARCODE")
    expect((await createProduct(as.outsider, product({ barcode: "4801234567890" }))).status).toBe(201) // another organization

    const second = await newProduct({ barcode: "4801234567891" })
    const clash = await patchProduct(as.manager, second.id, { barcode: " 4801234567890 " })
    expect(clash.status).toBe(409)
    expect((await json(clash)).error.code).toBe("DUPLICATE_BARCODE")
    expect((await patchProduct(as.manager, first.id, { barcode: "4801234567890", name: "Same barcode" })).status).toBe(200)
  })

  it("patches only the given fields and bumps the version", async () => {
    const cat = await newCategory("Canned goods")
    const p = await newProduct({ barcode: "4800000000024", category_id: cat.id, wholesale_price: 20, wholesale_threshold: 12, notify_low_stock: true, low_stock_threshold: 5 })
    const res = await patchProduct(as.manager, p.id, { selling_price: 27.75 })
    expect(res.status).toBe(200)
    const { product: updated } = await json(res)
    expect(updated).toMatchObject({ ...p, selling_price: 27.75, version: updated.version, updated_at: updated.updated_at })
    expect(updated.version).toBeGreaterThan(p.version)

    const fetched = (await json(await getProduct(as.manager, p.id))).product
    expect(fetched).toEqual(updated)

    // The wholesale pair is checked on the product as it will be
    expect((await patchProduct(as.manager, p.id, { wholesale_price: null })).status).toBe(400)
    const cleared = await json(await patchProduct(as.manager, p.id, { wholesale_price: null, wholesale_threshold: null, barcode: "", category_id: null }))
    expect(cleared.product).toMatchObject({ wholesale_price: null, wholesale_threshold: 0, barcode: null, category_id: null, low_stock_threshold: 5 })

    expect((await patchProduct(as.manager, p.id, {})).status).toBe(400)
    expect((await patchProduct(as.manager, p.id, { unit_type: "LITER" })).status).toBe(400)
    expect((await patchProduct(as.manager, p.id, { category_id: randomUUID() })).status).toBe(400)
  })

  it("soft-deletes: hidden from lists, kept for history, and the barcode is free again", async () => {
    const p = await newProduct({ name: "Old soap", barcode: "4800000000031" })
    expect(await json(await deleteProduct(as.manager, p.id))).toEqual({ ok: true })

    expect(await productNames(await listProducts(as.manager))).not.toContain("Old soap")
    expect(await productNames(await listProducts(as.manager, "?include_deleted=1"))).toContain("Old soap")
    expect((await getProduct(as.manager, p.id)).status).toBe(404)
    const kept = await json(await getProduct(as.manager, p.id, "?include_deleted=1"))
    expect(kept.product.deleted_at).not.toBeNull()
    expect(kept.product.version).toBeGreaterThan(p.version)

    expect((await patchProduct(as.manager, p.id, { name: "Back" })).status).toBe(404)
    expect((await deleteProduct(as.manager, p.id)).status).toBe(404)
    const reused = await newProduct({ name: "New soap", barcode: "4800000000031" })
    expect(reused.barcode).toBe("4800000000031")
  })

  it("searches by name or barcode and filters by category", async () => {
    const cat = await newCategory("Condiments")
    await newProduct({ name: "Soy sauce 1L", barcode: "SOY-100", category_id: cat.id })
    await newProduct({ name: "Fish sauce 100%", barcode: "FISH_1", category_id: cat.id })
    await newProduct({ name: "Vinegar" })
    expect(await productNames(await listProducts(as.manager, "?search=SAUCE"))).toEqual(["Fish sauce 100%", "Soy sauce 1L"])
    expect(await productNames(await listProducts(as.manager, "?search=soy-1"))).toEqual(["Soy sauce 1L"])
    expect(await productNames(await listProducts(as.manager, "?search=100%25"))).toEqual(["Fish sauce 100%"])
    expect(await productNames(await listProducts(as.manager, "?search=H_1"))).toEqual(["Fish sauce 100%"])
    expect(await productNames(await listProducts(as.manager, `?category_id=${cat.id}`))).toEqual(["Fish sauce 100%", "Soy sauce 1L"])
    expect(await productNames(await listProducts(as.manager, "?category_id=junk"))).toEqual([])
  })

  it("adds the store's stock and low-stock flag with ?store_id=", async () => {
    const low = await newProduct({ name: "Matches", notify_low_stock: true, low_stock_threshold: 5 })
    const quiet = await newProduct({ name: "Candles", notify_low_stock: false, low_stock_threshold: 5 })
    const move = (productId: string, quantity_delta: number) =>
      MOVE_STOCK(req("POST", `/api/stores/${s.ids.store}/stock-movements`, { cookie: as.manager, body: { product_id: productId, quantity_delta, reason: "RESTOCK" } }), params({ storeId: s.ids.store }))
    await move(low.id, 4)
    await move(quiet.id, 2)

    const rows = (await json(await listProducts(as.manager, `?store_id=${s.ids.store}&search=a`))).products as Json[]
    const byName = Object.fromEntries(rows.map((p) => [p.name, p]))
    expect(byName.Matches).toMatchObject({ stock_level: 4, is_low_stock: true })
    expect(byName.Candles).toMatchObject({ stock_level: 2, is_low_stock: false })
    expect(rows.every((p) => typeof p.stock_level === "number")).toBe(true)

    const branch = (await json(await listProducts(as.owner, `?store_id=${s.ids.branch}&search=matches`))).products
    expect(branch).toMatchObject([{ name: "Matches", stock_level: 0, is_low_stock: true }])
    expect((await listProducts(as.manager)).status).toBe(200)
    expect(((await json(await listProducts(as.manager))).products as Json[])[0]).not.toHaveProperty("stock_level")
    expect((await listProducts(as.manager, `?store_id=${s.ids.branch}`)).status).toBe(404) // not the manager's store
    expect((await listProducts(as.owner, `?store_id=${s.ids.foreignStore}`)).status).toBe(404)
    expect((await listProducts(as.owner, "?store_id=junk")).status).toBe(404)
  })

  it("keeps each organization to its own catalog", async () => {
    const ours = await newProduct({ name: "Ours only" })
    expect(await productNames(await listProducts(as.outsider))).not.toContain("Ours only")
    expect((await getProduct(as.outsider, ours.id)).status).toBe(404)
    expect((await getProduct(as.outsider, ours.id, "?include_deleted=1")).status).toBe(404)
    expect((await patchProduct(as.outsider, ours.id, { name: "Theirs" })).status).toBe(404)
    expect((await deleteProduct(as.outsider, ours.id)).status).toBe(404)
    expect((await getProduct(as.manager, "not-a-uuid")).status).toBe(404)
    expect((await getProduct(as.manager, randomUUID())).status).toBe(404)
  })

  it("is for managers", async () => {
    expect((await listProducts(as.cashier)).status).toBe(403)
    expect((await createProduct(as.cashier, product())).status).toBe(403)
    expect((await LIST_PRODUCTS(req("GET", "/api/products"))).status).toBe(401)
    expect((await CREATE_PRODUCT(req("POST", "/api/products", { cookie: as.manager, body: product(), origin: "https://evil.example" }))).status).toBe(403)
  })
})
