import { and, eq, isNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { categories, products, stockMovements, stores, users } from "@pos/db"
import { POST as CREATE_CATEGORY } from "@/app/api/categories/route"
import { GET as EXPORT } from "@/app/api/products/export/route"
import { POST as IMPORT } from "@/app/api/products/import/route"
import { DELETE as DELETE_PRODUCT } from "@/app/api/products/[id]/route"
import { POST as CREATE_PRODUCT } from "@/app/api/products/route"
import { POST as MOVE_STOCK } from "@/app/api/stores/[storeId]/stock-movements/route"
import { createSession } from "@/lib/auth/session"
import { CSV_HEADERS, parseCsv } from "@/lib/catalog/csv"
import { stockLevel } from "@/lib/catalog/stock"
import { params, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let otherOrg = ""
let outsiderId = ""
const as: Record<"owner" | "manager" | "cashier" | "outsider", string> = { owner: "", manager: "", cashier: "", outsider: "" }

type Json = Record<string, any>
const json = async (res: Response) => (await res.json()) as Json

let coke: Json
let rice: Json

beforeAll(async () => {
  s = await setupTestServer()
  ;[{ org_id: otherOrg }] = await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore))
  const [outsider] = await s.db.insert(users).values({ org_id: otherOrg, full_name: "Otto Outsider", role: "OWNER", email: "otto@example.com" }).returning()
  outsiderId = outsider.id
  const cookie = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
  as.owner = await cookie(s.ids.owner)
  as.manager = await cookie(s.ids.manager)
  as.cashier = await cookie(s.ids.cashier)
  as.outsider = await cookie(outsider.id)

  // A small catalog with stock in the main store
  const category = (await json(await CREATE_CATEGORY(req("POST", "/api/categories", { cookie: as.manager, body: { name: "Beverages" } })))).category
  const create = async (body: Json) => (await json(await CREATE_PRODUCT(req("POST", "/api/products", { cookie: as.manager, body })))).product
  coke = await create({
    name: 'Coke, 1.5L "Big"',
    barcode: "4801981116188",
    selling_price: 85,
    cost_price: 70.25,
    unit_type: "QUANTITY",
    category_id: category.id,
    wholesale_price: 80,
    wholesale_threshold: 12,
    low_stock_threshold: 6,
    notify_low_stock: true,
    is_promo: true,
    promo_price: 79.5,
  })
  rice = await create({ name: "Dinorado rice", selling_price: 62.5, cost_price: 55, unit_type: "WEIGHT", tax_category: "VAT_EXEMPT", supplier_type: "WET_MARKET" })
  const gone = await create({ name: "Discontinued", selling_price: 1, cost_price: 1, unit_type: "QUANTITY" })
  await DELETE_PRODUCT(req("DELETE", `/api/products/${gone.id}`, { cookie: as.manager }), params({ id: gone.id }))
  const move = (product_id: string, quantity_delta: number) =>
    MOVE_STOCK(req("POST", `/api/stores/${s.ids.store}/stock-movements`, { cookie: as.manager, body: { product_id, quantity_delta, reason: "RESTOCK" } }), params({ storeId: s.ids.store }))
  await move(coke.id, 24)
  await move(rice.id, 12.5)
  await move(rice.id, -0.3)
})
afterAll(() => s.close())

const exportCsv = (cookie: string, query = "") => EXPORT(req("GET", `/api/products/export${query}`, { cookie }))
const upload = (cookie: string, csv: string | null, query = "") => {
  const form = new FormData()
  if (csv !== null) form.set("file", new File([csv], "products.csv", { type: "text/csv" }))
  return IMPORT(new Request(`http://localhost/api/products/import${query}`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", cookie }, body: form }))
}
const rowsOf = (csv: string) => {
  const [header, ...rest] = parseCsv(csv)
  return rest.map((r) => Object.fromEntries(header.fields.map((h, i) => [h, r.fields[i]])))
}
const productIn = async (orgId: string, name: string) => {
  const [row] = await s.db.select().from(products).where(and(eq(products.org_id, orgId), eq(products.name, name), isNull(products.deleted_at)))
  return row
}
const importFields = (p: Json) => {
  const { id, org_id, category_id, version, created_at, updated_at, deleted_at, ...fields } = p
  return fields
}

describe("GET /api/products/export", () => {
  it("writes POS-bir's columns; stock_level only for a store", async () => {
    const res = await exportCsv(as.manager)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/)
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="products_\d{4}-\d{2}-\d{2}\.csv"$/)
    const text = await res.text()
    expect(text.split("\n")[0]).toBe(CSV_HEADERS.filter((h) => h !== "stock_level").join(","))
    expect(rowsOf(text).map((r) => r.name)).toEqual(['Coke, 1.5L "Big"', "Dinorado rice"]) // deleted products left out

    const withStock = await (await exportCsv(as.manager, `?store_id=${s.ids.store}`)).text()
    expect(withStock.split("\n")[0]).toBe(CSV_HEADERS.join(","))
    expect(withStock).toContain('"Coke, 1.5L ""Big"""') // quoted, quotes doubled
    const [c, r] = rowsOf(withStock)
    expect(c).toEqual({
      name: 'Coke, 1.5L "Big"',
      barcode: "4801981116188",
      selling_price: "85",
      cost_price: "70.25",
      stock_level: "24",
      unit_type: "QUANTITY",
      low_stock_threshold: "6",
      notify_low_stock: "1",
      category: "Beverages",
      tax_category: "VATABLE",
      supplier_type: "WHOLESALER",
      is_promo: "1",
      promo_price: "79.5",
      wholesale_price: "80",
      wholesale_threshold: "12",
      updated_at: new Date(coke.updated_at).toISOString(),
    })
    expect(r).toMatchObject({ name: "Dinorado rice", barcode: "", stock_level: "12.2", unit_type: "WEIGHT", category: "", notify_low_stock: "0", promo_price: "", wholesale_price: "" })
  })

  it("is scoped like the other routes", async () => {
    expect((await exportCsv(as.manager, `?store_id=${s.ids.branch}`)).status).toBe(404)
    expect((await exportCsv(as.owner, `?store_id=${s.ids.foreignStore}`)).status).toBe(404)
    expect(rowsOf(await (await exportCsv(as.outsider)).text())).toEqual([])
    expect((await exportCsv(as.cashier)).status).toBe(403)
  })
})

describe("POST /api/products/import", () => {
  it("round-trips an export into another organization, stock included", async () => {
    const csv = await (await exportCsv(as.owner, `?store_id=${s.ids.store}`)).text()
    const res = await upload(as.outsider, csv, `?store_id=${s.ids.foreignStore}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ created: 2, updated: 0, skipped: 0, errors: [] })

    for (const original of [coke, rice]) {
      const copy = await productIn(otherOrg, original.name)
      expect(importFields(copy)).toEqual(importFields(original))
    }
    const theirCoke = await productIn(otherOrg, coke.name)
    const [category] = await s.db.select().from(categories).where(eq(categories.id, theirCoke.category_id!))
    expect(category).toMatchObject({ org_id: otherOrg, name: "Beverages" })

    // Opening stock arrives as back-office adjustments in the chosen store
    const theirRice = await productIn(otherOrg, "Dinorado rice")
    expect(await stockLevel(s.db, s.ids.foreignStore, theirCoke.id)).toBe(24)
    expect(await stockLevel(s.db, s.ids.foreignStore, theirRice.id)).toBe(12.2)
    const movements = await s.db.select().from(stockMovements).where(eq(stockMovements.product_id, theirRice.id))
    expect(movements).toMatchObject([{ store_id: s.ids.foreignStore, reason: "ADJUSTMENT", quantity_delta: 12.2, terminal_id: null, device_seq: null, created_by: outsiderId }])
  })

  it("skips rows that aren't newer than the product (POS-bir's smart merge)", async () => {
    const csv = await (await exportCsv(as.owner, `?store_id=${s.ids.store}`)).text()
    const before = await productIn(s.ids.org, coke.name)
    expect(await json(await upload(as.manager, csv, `?store_id=${s.ids.store}`))).toEqual({ created: 0, updated: 0, skipped: 2, errors: [] })
    expect((await productIn(s.ids.org, coke.name)).version).toBe(before.version)

    const header = "name,selling_price,cost_price,unit_type,updated_at"
    const older = await json(await upload(as.manager, `${header}\nDinorado rice,70,55,WEIGHT,2020-01-01 08:00:00\n`))
    expect(older).toMatchObject({ updated: 0, skipped: 1 })
    const newer = await json(await upload(as.manager, `${header}\nDinorado rice,64,55,WEIGHT,2999-01-01T00:00:00Z\n`))
    expect(newer).toMatchObject({ updated: 1, skipped: 0 })
    expect((await productIn(s.ids.org, "Dinorado rice")).selling_price).toBe(64)
    expect(await json(await upload(as.manager, `${header}\nDinorado rice,62.5,55,WEIGHT,yesterday\n`))).toMatchObject({ updated: 0, errors: [{ row: 2, message: "updated_at: not a date" }] })
  })

  it("only updates the columns in the header", async () => {
    const before = await productIn(s.ids.org, coke.name)
    const csv = `name,barcode,selling_price,cost_price,unit_type\n"${coke.name.replace(/"/g, '""')}",4801981116188,"₱1,090.00",72,quantity\n`
    expect(await json(await upload(as.manager, csv))).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] })
    const after = await productIn(s.ids.org, coke.name)
    expect(after).toMatchObject({
      ...before,
      selling_price: 1090,
      cost_price: 72,
      version: after.version,
      updated_at: after.updated_at,
    })
    expect(after.version).toBeGreaterThan(before.version)
    expect(after).toMatchObject({ category_id: coke.category_id, wholesale_price: 80, wholesale_threshold: 12, is_promo: true, promo_price: 79.5, notify_low_stock: true })
    expect(await stockLevel(s.db, s.ids.store, coke.id)).toBe(24) // no stock column, no movement
  })

  it("sets stock to the file's level with one adjustment, and leaves blank cells alone", async () => {
    const header = "name,barcode,selling_price,cost_price,unit_type,stock_level,category,tax_category"
    const csv = [header, "Renamed Coke,4801981116188,85,70.25,QUANTITY,30,soft drinks,vat exempt", "Dinorado rice,,62.5,55,WEIGHT,,,VAT_EXEMPT"].join("\r\n")
    expect(await json(await upload(as.manager, csv, `?store_id=${s.ids.store}`))).toEqual({ created: 0, updated: 2, skipped: 0, errors: [] })

    // Matched by barcode, so the name changed instead of a new product appearing
    const renamed = await productIn(s.ids.org, "Renamed Coke")
    expect(renamed.id).toBe(coke.id)
    expect(renamed.tax_category).toBe("VAT_EXEMPT")
    const [category] = await s.db.select().from(categories).where(eq(categories.id, renamed.category_id!))
    expect(category.name).toBe("soft drinks") // created by the import
    expect(await stockLevel(s.db, s.ids.store, coke.id)).toBe(30)
    const adjustments = await s.db.select().from(stockMovements).where(and(eq(stockMovements.product_id, coke.id), eq(stockMovements.reason, "ADJUSTMENT")))
    expect(adjustments).toMatchObject([{ quantity_delta: 6, created_by: s.ids.manager, note: "CSV import" }])

    const riceNow = await productIn(s.ids.org, "Dinorado rice")
    expect(riceNow.category_id).toBeNull()
    expect(await stockLevel(s.db, s.ids.store, rice.id)).toBe(12.2)
    // An existing category is matched ignoring case
    await upload(as.manager, "name,selling_price,cost_price,unit_type,category\nDinorado rice,62.5,55,WEIGHT,SOFT DRINKS\n")
    expect((await productIn(s.ids.org, "Dinorado rice")).category_id).toBe(renamed.category_id)
  })

  it("reports bad rows by line and saves the good ones", async () => {
    const csv = [
      "﻿Name,Selling_Price,cost_price,unit_type,stock_level,tax_category,wholesale_price,wholesale_threshold,notify_low_stock",
      "Good one,10,8,QUANTITY,5,,,,1",
      ",10,8,QUANTITY,,,,,",
      "Bad price,abc,8,QUANTITY,,,,,",
      "Negative,-1,8,QUANTITY,,,,,",
      "",
      "Bad unit,10,8,LITER,,,,,",
      "Half a box,10,8,QUANTITY,1.5,,,,",
      "Bad tax,10,8,QUANTITY,,VAT,,,",
      "Wholesale alone,10,8,QUANTITY,,,9,,",
      "Short,10,8",
      "Odd flag,10,8,QUANTITY,,,,,maybe",
      '"Multi\nline",10,8,QUANTITY,,,,,',
      "Grams,10,8,WEIGHT,1.2345,,,,",
      "POS-bir no wholesale,10,8,QUANTITY,0,,0,0,0",
      ",,,,,,,,",
    ].join("\n")
    const res = await json(await upload(as.manager, csv, `?store_id=${s.ids.store}`))
    expect(res).toMatchObject({ created: 3, updated: 0, skipped: 0 })
    expect(res.errors).toEqual([
      { row: 3, message: "missing name" },
      { row: 4, message: "selling_price: not a number" },
      { row: 5, message: expect.stringMatching(/^selling_price: /) },
      { row: 7, message: expect.stringMatching(/^unit_type: /) },
      { row: 8, message: "stock_level: a whole number for QUANTITY products" },
      { row: 9, message: expect.stringMatching(/^tax_category: /) },
      { row: 10, message: expect.stringMatching(/^wholesale_threshold: /) },
      { row: 11, message: "not enough columns" },
      { row: 12, message: "notify_low_stock: expected 1 or 0" },
      { row: 15, message: "stock_level: at most 3 decimal places for WEIGHT products" },
    ])
    const good = await productIn(s.ids.org, "Good one")
    expect(good).toMatchObject({ notify_low_stock: true, selling_price: 10 })
    expect(await stockLevel(s.db, s.ids.store, good.id)).toBe(5)
    expect(await productIn(s.ids.org, "Multi\nline")).toBeDefined()
    expect(await productIn(s.ids.org, "POS-bir no wholesale")).toMatchObject({ wholesale_price: null, wholesale_threshold: 0 })
    expect(await productIn(s.ids.org, "Bad price")).toBeUndefined()
  })

  it("matches by name when there's no barcode, and sets the barcode", async () => {
    const csv = "name,barcode,selling_price,cost_price,unit_type\nGood one,4800000000055,11,8,QUANTITY\n"
    expect(await json(await upload(as.manager, csv))).toMatchObject({ created: 0, updated: 1 })
    expect(await productIn(s.ids.org, "Good one")).toMatchObject({ barcode: "4800000000055", selling_price: 11 })
  })

  it("refuses files it can't read", async () => {
    const expectInvalid = async (res: Response, path: string) => {
      expect(res.status).toBe(400)
      const { error } = await json(res)
      expect(error.code).toBe("INVALID_INPUT")
      expect(error.issues.map((i: Json) => i.path)).toContain(path)
      return error
    }
    await expectInvalid(await upload(as.manager, null), "file")
    await expectInvalid(await upload(as.manager, ""), "file")
    await expectInvalid(await upload(as.manager, "name,selling_price,cost_price,unit_type\n"), "file")
    const missing = await expectInvalid(await upload(as.manager, "name,price\nCoke,10\n"), "file")
    expect(missing.issues.map((i: Json) => i.message)).toEqual(["Missing required column: selling_price", "Missing required column: cost_price", "Missing required column: unit_type"])
    // A stock column needs the store it counts
    await expectInvalid(await upload(as.manager, "name,selling_price,cost_price,unit_type,stock_level\nX,1,1,QUANTITY,1\n"), "store_id")
    const notMultipart = await IMPORT(req("POST", "/api/products/import", { cookie: as.manager, body: { file: "name" } }))
    await expectInvalid(notMultipart, "file")
  })

  it("is scoped like the other routes", async () => {
    const csv = "name,selling_price,cost_price,unit_type,stock_level\nX,1,1,QUANTITY,1\n"
    expect((await upload(as.manager, csv, `?store_id=${s.ids.branch}`)).status).toBe(404)
    expect((await upload(as.owner, csv, `?store_id=${s.ids.foreignStore}`)).status).toBe(404)
    expect((await upload(as.cashier, csv, `?store_id=${s.ids.store}`)).status).toBe(403)
    const crossSite = await IMPORT(new Request("http://localhost/api/products/import", { method: "POST", headers: { host: "localhost", origin: "https://evil.example", cookie: as.manager }, body: new FormData() }))
    expect(crossSite.status).toBe(403)
    expect(await productIn(s.ids.org, "X")).toBeUndefined()
  })
})
