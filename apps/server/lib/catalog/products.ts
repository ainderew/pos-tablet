// Product rules for POST/PATCH /api/products and the CSV import (one set of rules for both)
import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { TaxCategorySchema, UnitTypeSchema } from "@pos/core"
import { categories, products } from "@pos/db"
import type { Db } from "@pos/db"
import { z } from "zod"
import { count, definedOnly, money, optionalMoney, optionalText, optionalUuid, requiredText } from "./validation"
import type { Issue } from "./validation"

export type ProductRow = typeof products.$inferSelect
/** Drizzle's transaction handle has the same query API as the database */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type DbOrTx = Db | Tx

export const SUPPLIER_TYPES = ["WHOLESALER", "WET_MARKET", "DIRECT_DELIVERY"] as const

const productFields = {
  name: requiredText(200),
  barcode: optionalText(64),
  selling_price: money,
  cost_price: money,
  unit_type: UnitTypeSchema,
  tax_category: TaxCategorySchema,
  supplier_type: z.enum(SUPPLIER_TYPES),
  category_id: optionalUuid,
  wholesale_price: optionalMoney,
  // Not set = 0 (the column is NOT NULL); null and "" mean the same
  wholesale_threshold: z.preprocess((v) => (v === "" || v === null ? 0 : v), count),
  low_stock_threshold: count,
  notify_low_stock: z.boolean(),
  is_promo: z.boolean(),
  promo_price: optionalMoney,
}

export const ProductPatchSchema = z.object(productFields).partial()
export const ProductCreateSchema = ProductPatchSchema.required({ name: true, selling_price: true, cost_price: true, unit_type: true })
export type ProductInput = z.infer<typeof ProductPatchSchema>

/** Every column a product form (or CSV row) sets */
export type ProductValues = Pick<
  ProductRow,
  | "name"
  | "barcode"
  | "selling_price"
  | "cost_price"
  | "unit_type"
  | "tax_category"
  | "supplier_type"
  | "category_id"
  | "wholesale_price"
  | "wholesale_threshold"
  | "low_stock_threshold"
  | "notify_low_stock"
  | "is_promo"
  | "promo_price"
>

const DEFAULTS: Omit<ProductValues, "name" | "selling_price" | "cost_price" | "unit_type"> = {
  barcode: null,
  tax_category: "VATABLE",
  supplier_type: "WHOLESALER",
  category_id: null,
  wholesale_price: null,
  wholesale_threshold: 0,
  low_stock_threshold: 0,
  notify_low_stock: false,
  is_promo: false,
  promo_price: null,
}

export const productValuesOf = (p: ProductRow): ProductValues => ({
  name: p.name,
  barcode: p.barcode,
  selling_price: p.selling_price,
  cost_price: p.cost_price,
  unit_type: p.unit_type,
  tax_category: p.tax_category,
  supplier_type: p.supplier_type,
  category_id: p.category_id,
  wholesale_price: p.wholesale_price,
  wholesale_threshold: p.wholesale_threshold,
  low_stock_threshold: p.low_stock_threshold,
  notify_low_stock: p.notify_low_stock,
  is_promo: p.is_promo,
  promo_price: p.promo_price,
})

/**
 * The product as it will be saved: `input` over the existing product (PATCH, import update) or the
 * defaults (POST, import create), with the rules that span fields checked on the result.
 *
 * Wholesale: the price and threshold are set together (price above 0 and threshold of at least 1,
 * which is when @pos/core applies the wholesale price) or not at all. POS-bir's form saves "no
 * wholesale" as price 0 / threshold 0, so that is accepted and stored as null / 0.
 */
export function mergeProduct(base: ProductValues | null, input: ProductInput): { ok: true; values: ProductValues } | { ok: false; issues: Issue[] } {
  const merged = { ...DEFAULTS, ...(base ?? {}), ...definedOnly(input) } as ProductValues
  const priceSet = merged.wholesale_price != null && merged.wholesale_price > 0
  const thresholdSet = merged.wholesale_threshold > 0
  if (priceSet !== thresholdSet) {
    const message = "wholesale_price and wholesale_threshold are set together (price above 0, threshold of at least 1) or not at all"
    return { ok: false, issues: [{ path: priceSet ? "wholesale_threshold" : "wholesale_price", message }] }
  }
  if (!priceSet) {
    merged.wholesale_price = null
    merged.wholesale_threshold = 0
  }
  return { ok: true, values: merged }
}

/** The organization's product (deleted ones only when asked) */
export async function productInOrg(db: DbOrTx, orgId: string, id: string, opts: { includeDeleted?: boolean } = {}) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.org_id, orgId), opts.includeDeleted ? undefined : isNull(products.deleted_at)))
  return row ?? null
}

/** Barcodes are unique among the organization's active products */
export async function barcodeTaken(db: DbOrTx, orgId: string, barcode: string, exceptId?: string) {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.org_id, orgId), eq(products.barcode, barcode), isNull(products.deleted_at), exceptId ? ne(products.id, exceptId) : undefined))
    .limit(1)
  return !!row
}

/**
 * Whether the category exists and is active in the organization. Inside a transaction this also
 * share-locks it, so a concurrent DELETE /api/categories/:id can't remove it from under the product
 * (that DELETE locks the row before counting the products that use it).
 */
export async function activeCategoryLocked(tx: DbOrTx, orgId: string, categoryId: string) {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.org_id, orgId), isNull(categories.deleted_at)))
    .for("share")
  return !!row
}

export const BARCODE_INDEX = "products_barcode_idx"

/** Products ordered for lists and the export: by name, ignoring case */
export const productOrder = [sql`lower(${products.name})`, products.name, products.id]
