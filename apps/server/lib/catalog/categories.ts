// Categories belong to the organization; names are unique among its active categories, ignoring case
import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { z } from "zod"
import { categories, products } from "@pos/db"
import type { DbOrTx } from "./products"
import { requiredText } from "./validation"

export const CATEGORY_NAME_MAX = 80
export const CategorySchema = z.object({ name: requiredText(CATEGORY_NAME_MAX) })
export const NAME_INDEX = "categories_name_idx"

/**
 * Active products in the category (a category can't be deleted while this isn't 0). Written with
 * explicit qualifiers: Drizzle leaves columns unqualified in a single-table select, which would turn
 * the correlation into products.category_id = products.id.
 */
export const productCount = () =>
  sql<number>`(select count(*) from ${products} as counted where counted.category_id = ${categories}.id and counted.deleted_at is null)`.mapWith(Number)

export async function categoryNameTaken(db: DbOrTx, orgId: string, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.org_id, orgId),
        sql`lower(${categories.name}) = lower(${name})`,
        isNull(categories.deleted_at),
        exceptId ? ne(categories.id, exceptId) : undefined
      )
    )
    .limit(1)
  return !!row
}

/** The organization's active category with its product_count, as the API returns it */
export async function categoryWithCount(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select({ category: categories, product_count: productCount() })
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.org_id, orgId), isNull(categories.deleted_at)))
  return row ? { ...row.category, product_count: row.product_count } : null
}
