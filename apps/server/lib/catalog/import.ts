// POST /api/products/import: POS-bir's CSV import, on the organization catalog.
//
// Kept from POS-bir: required columns (name, selling_price, cost_price, unit_type); match by barcode,
// else by exact name; a missing category is created; a row whose updated_at is not newer than the
// product's is skipped; and only the columns present in the header are updated, so a partial CSV
// leaves the other fields alone.
// Changed: rows are validated with the same rules as POST/PATCH and a bad row is reported instead of
// aborting the file (or being saved with defaults); stock_level becomes an ADJUSTMENT movement in the
// store given as ?store_id= (the stock column is the store's level, so the movement is the
// difference); a blank stock cell leaves the stock alone. Everything is written in one transaction.
import { and, asc, eq, isNull } from "drizzle-orm"
import { categories, products } from "@pos/db"
import type { Db } from "@pos/db"
import { CATEGORY_NAME_MAX, NAME_INDEX } from "./categories"
import { enumCell, parseCsvBoolean, parseCsvNumber, parseCsvTimestamp, REQUIRED_COLUMNS } from "./csv"
import type { CsvRecord } from "./csv"
import { isUniqueViolation } from "./db-errors"
import { activeCategoryLocked, BARCODE_INDEX, mergeProduct, ProductPatchSchema, productValuesOf } from "./products"
import type { ProductRow } from "./products"
import { insertBackOfficeMovement, stockLevels } from "./stock"
import { round3, validQuantity } from "./validation"

export type ImportResult = { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] }

/** The organization's active products, kept current as the import writes, for matching rows */
class CatalogIndex {
  private byId = new Map<string, ProductRow>()
  private byBarcode = new Map<string, string>()
  private byName = new Map<string, ProductRow[]>()

  constructor(rows: ProductRow[]) {
    for (const row of rows) this.add(row)
  }

  /** By barcode, else by name (the oldest product with that name) */
  find(barcode: string | null | undefined, name: string): ProductRow | undefined {
    const id = barcode ? this.byBarcode.get(barcode) : undefined
    return (id && this.byId.get(id)) || this.byName.get(name)?.[0]
  }

  put(row: ProductRow) {
    const previous = this.byId.get(row.id)
    if (previous) this.remove(previous)
    this.add(row)
  }

  private add(row: ProductRow) {
    this.byId.set(row.id, row)
    if (row.barcode) this.byBarcode.set(row.barcode, row.id)
    const named = [...(this.byName.get(row.name) ?? []), row]
    named.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
    this.byName.set(row.name, named)
  }

  private remove(row: ProductRow) {
    this.byId.delete(row.id)
    if (row.barcode && this.byBarcode.get(row.barcode) === row.id) this.byBarcode.delete(row.barcode)
    const named = (this.byName.get(row.name) ?? []).filter((p) => p.id !== row.id)
    if (named.length) this.byName.set(row.name, named)
    else this.byName.delete(row.name)
  }
}

type ParsedRow = {
  input: Record<string, unknown>
  categoryName?: string | null // undefined: no category column
  stockTarget?: number // undefined: no stock column, or a blank cell
  updatedAt?: Date
}

/** One CSV row as a PATCH-shaped object (only the columns in the header), or what is wrong with it */
function parseRow(cell: (column: string) => string, has: (column: string) => boolean): { ok: true; row: ParsedRow } | { ok: false; message: string } {
  const problems: string[] = []
  const number = (column: string, blank: number | null) => {
    const n = parseCsvNumber(cell(column))
    if (Number.isNaN(n)) problems.push(`${column}: not a number`)
    return n ?? blank
  }
  const boolean = (column: string) => {
    const b = parseCsvBoolean(cell(column))
    if (b === null) problems.push(`${column}: expected 1 or 0`)
    return b ?? false
  }

  const input: Record<string, unknown> = {
    name: cell("name"),
    selling_price: number("selling_price", null),
    cost_price: number("cost_price", null),
    unit_type: enumCell(cell("unit_type")),
  }
  // POS-bir's defaults for blank cells
  if (has("barcode")) input.barcode = cell("barcode")
  if (has("low_stock_threshold")) input.low_stock_threshold = number("low_stock_threshold", 0)
  if (has("notify_low_stock")) input.notify_low_stock = boolean("notify_low_stock")
  if (has("tax_category")) input.tax_category = cell("tax_category") ? enumCell(cell("tax_category")) : "VATABLE"
  if (has("supplier_type")) input.supplier_type = cell("supplier_type") ? enumCell(cell("supplier_type")) : "WHOLESALER"
  if (has("is_promo")) input.is_promo = boolean("is_promo")
  if (has("promo_price")) input.promo_price = number("promo_price", null)
  if (has("wholesale_price")) input.wholesale_price = number("wholesale_price", null)
  if (has("wholesale_threshold")) input.wholesale_threshold = number("wholesale_threshold", 0)

  const row: ParsedRow = { input }
  if (has("category")) {
    const name = cell("category")
    if (name.length > CATEGORY_NAME_MAX) problems.push(`category: at most ${CATEGORY_NAME_MAX} characters`)
    row.categoryName = name || null
  }
  if (has("stock_level") && cell("stock_level") !== "") {
    const n = parseCsvNumber(cell("stock_level"))
    if (n === null || Number.isNaN(n)) problems.push("stock_level: not a number")
    else row.stockTarget = n
  }
  if (has("updated_at") && cell("updated_at") !== "") {
    const date = parseCsvTimestamp(cell("updated_at"))
    if (!date) problems.push("updated_at: not a date")
    else row.updatedAt = date
  }
  if (problems.length) return { ok: false, message: problems.join("; ") }
  return { ok: true, row }
}

const quantityRule = (unitType: string) =>
  unitType === "QUANTITY" ? "a whole number for QUANTITY products" : "at most 3 decimal places for WEIGHT products"

export async function importProducts(
  db: Db,
  opts: { orgId: string; userId: string; storeId: string | null; headers: string[]; records: CsvRecord[] }
): Promise<ImportResult> {
  const { orgId, userId, storeId, headers } = opts
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  const columnIndex = new Map<string, number>()
  headers.forEach((h, i) => columnIndex.set(h, i)) // a repeated header: the last one wins, as in POS-bir
  const has = (column: string) => columnIndex.has(column)
  if (has("stock_level") && !storeId) throw new Error("importProducts: a stock_level column needs a store")

  await db.transaction(async (tx) => {
    const catalog = new CatalogIndex(
      await tx
        .select()
        .from(products)
        .where(and(eq(products.org_id, orgId), isNull(products.deleted_at)))
        .orderBy(asc(products.created_at), asc(products.id))
    )
    const categoryIds = new Map(
      (await tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.org_id, orgId), isNull(categories.deleted_at)))).map((c) => [c.name.toLowerCase(), c.id])
    )
    const stock = storeId && has("stock_level") ? await stockLevels(tx, storeId) : new Map<string, number>()

    for (const record of opts.records) {
      const fail = (message: string) => result.errors.push({ row: record.line, message })
      if (record.fields.length < headers.length) {
        fail("not enough columns")
        continue
      }
      const cell = (column: string) => record.fields[columnIndex.get(column) ?? -1] ?? ""
      const missing = REQUIRED_COLUMNS.filter((c) => cell(c) === "")
      if (missing.length) {
        fail(`missing ${missing.join(", ")}`)
        continue
      }

      const parsed = parseRow(cell, has)
      if (!parsed.ok) {
        fail(parsed.message)
        continue
      }
      const { categoryName, stockTarget, updatedAt } = parsed.row
      const checked = ProductPatchSchema.safeParse(parsed.row.input)
      if (!checked.success) {
        fail(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
        continue
      }
      const input = checked.data

      const existing = catalog.find(input.barcode, input.name!)
      // Smart merge (POS-bir): a row exported before the product last changed doesn't overwrite it
      if (existing && updatedAt && updatedAt.getTime() <= existing.updated_at.getTime()) {
        result.skipped++
        continue
      }

      // Category by name, ignoring case; a new name creates the category when the row is saved
      let newCategory: string | null = null
      if (categoryName !== undefined) {
        const id = categoryName === null ? null : categoryIds.get(categoryName.toLowerCase())
        if (id === undefined) newCategory = categoryName
        // Share-lock it like POST/PATCH do, so a concurrent category delete can't slip in between
        else if (id !== null && !(await activeCategoryLocked(tx, orgId, id))) {
          fail(`category "${categoryName}" was just deleted`)
          continue
        } else input.category_id = id
      }

      const merged = mergeProduct(existing ? productValuesOf(existing) : null, input)
      if (!merged.ok) {
        fail(merged.issues.map((i) => `${i.path}: ${i.message}`).join("; "))
        continue
      }
      const values = merged.values

      // The stock column is the store's level: move stock by the difference
      let delta = 0
      const current = existing ? (stock.get(existing.id) ?? 0) : 0
      if (stockTarget !== undefined) {
        if (!validQuantity(values.unit_type, stockTarget)) {
          fail(`stock_level: ${quantityRule(values.unit_type)}`)
          continue
        }
        delta = round3(stockTarget - current)
        if (delta !== 0 && !validQuantity(values.unit_type, delta)) {
          fail(`stock_level: the change (${delta}) must be ${quantityRule(values.unit_type)}`)
          continue
        }
      }

      try {
        // A savepoint per row: a row the database refuses (a barcode saved elsewhere meanwhile) is
        // reported without undoing the rows before it
        const saved = await tx.transaction(async (sp) => {
          let categoryId = values.category_id
          if (newCategory) {
            const [category] = await sp.insert(categories).values({ org_id: orgId, name: newCategory }).returning({ id: categories.id })
            categoryId = category.id
          }
          const row = { ...values, category_id: categoryId }
          const [product] = existing
            ? await sp.update(products).set(row).where(eq(products.id, existing.id)).returning()
            : await sp.insert(products).values({ ...row, org_id: orgId }).returning()
          if (delta !== 0 && storeId) {
            await insertBackOfficeMovement(sp, { storeId, productId: product.id, userId, quantityDelta: delta, reason: "ADJUSTMENT", note: "CSV import" })
          }
          return product
        })
        catalog.put(saved)
        if (newCategory && saved.category_id) categoryIds.set(newCategory.toLowerCase(), saved.category_id)
        if (delta !== 0) stock.set(saved.id, round3(current + delta))
        if (existing) result.updated++
        else result.created++
      } catch (err) {
        if (isUniqueViolation(err, BARCODE_INDEX)) fail(`barcode ${values.barcode} is already used by another product`)
        else if (isUniqueViolation(err, NAME_INDEX)) fail(`category ${newCategory} already exists`)
        else throw err
      }
    }
  })
  return result
}
