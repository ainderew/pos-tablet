// Stock per store is the sum of its stock movements (terminals' sales, voids and restocks, plus the
// back office's restocks and adjustments). Summed in SQL on numeric, so 0.7 - 0.4 is exactly 0.3.
import { randomUUID } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import { stockMovements } from "@pos/db"
import type { DbOrTx } from "./products"

/** round(sum(quantity_delta), 3) as a number; 0 when there are no movements */
export const stockSum = () => sql<number>`round(coalesce(sum(${stockMovements.quantity_delta}), 0), 3)`.mapWith(Number)

/** Stock levels in a store for the given products (all products with movements when omitted) */
export async function stockLevels(db: DbOrTx, storeId: string, productIds?: string[]): Promise<Map<string, number>> {
  if (productIds && productIds.length === 0) return new Map()
  const rows = await db
    .select({ product_id: stockMovements.product_id, stock_level: stockSum() })
    .from(stockMovements)
    .where(and(eq(stockMovements.store_id, storeId), productIds ? inArray(stockMovements.product_id, productIds) : undefined))
    .groupBy(stockMovements.product_id)
  return new Map(rows.map((r) => [r.product_id, Number(r.stock_level)]))
}

export async function stockLevel(db: DbOrTx, storeId: string, productId: string): Promise<number> {
  return (await stockLevels(db, storeId, [productId])).get(productId) ?? 0
}

/** POS-bir's rule: only products that ask for it are flagged, while stock is below the threshold */
export const isLowStock = (p: { notify_low_stock: boolean; low_stock_threshold: number }, level: number) =>
  p.notify_low_stock && level < p.low_stock_threshold

export const BACK_OFFICE_REASONS = ["RESTOCK", "ADJUSTMENT"] as const

/**
 * A movement made in the back office: no terminal and no device_seq (the table's check requires
 * them to be null together), and it records who made it
 */
export async function insertBackOfficeMovement(
  db: DbOrTx,
  m: { storeId: string; productId: string; userId: string; quantityDelta: number; reason: (typeof BACK_OFFICE_REASONS)[number]; note?: string | null }
) {
  const [movement] = await db
    .insert(stockMovements)
    .values({
      id: randomUUID(),
      store_id: m.storeId,
      terminal_id: null,
      device_seq: null,
      created_by: m.userId,
      // The database clock, to the microsecond, so "newest first" holds even within one millisecond
      created_at: sql`clock_timestamp()`,
      product_id: m.productId,
      quantity_delta: m.quantityDelta,
      reason: m.reason,
      note: m.note ?? null,
    })
    .returning()
  return movement
}
