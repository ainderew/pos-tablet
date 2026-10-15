// The catalog as POS-bir's product CSV. stock_level is per store: it is included for ?store_id=
// (and that file then imports back with the same ?store_id=), and left out otherwise.
import { and, eq, isNull } from "drizzle-orm"
import { categories, products } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { CSV_HEADERS, csvLine } from "@/lib/catalog/csv"
import { productOrder } from "@/lib/catalog/products"
import { stockLevels } from "@/lib/catalog/stock"
import { getDb } from "@/lib/db"
import { notFound } from "@/lib/http"
import { storeForUser } from "@/lib/stores"

export async function GET(request: Request) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const storeId = new URL(request.url).searchParams.get("store_id")
  const store = storeId !== null ? await storeForUser(db, auth.user, storeId) : null
  if (storeId !== null && !store) return notFound("Store not found")

  const rows = await db
    .select({ product: products, category_name: categories.name })
    .from(products)
    .leftJoin(categories, and(eq(categories.id, products.category_id), isNull(categories.deleted_at)))
    .where(and(eq(products.org_id, auth.user.org_id), isNull(products.deleted_at)))
    .orderBy(...productOrder)
  const stock = store ? await stockLevels(db, store.id) : null

  const headers = CSV_HEADERS.filter((h) => h !== "stock_level" || stock)
  const lines = rows.map(({ product: p, category_name }) => {
    const value: Record<(typeof CSV_HEADERS)[number], unknown> = {
      name: p.name,
      barcode: p.barcode,
      selling_price: p.selling_price,
      cost_price: p.cost_price,
      stock_level: stock?.get(p.id) ?? 0,
      unit_type: p.unit_type,
      low_stock_threshold: p.low_stock_threshold,
      notify_low_stock: p.notify_low_stock ? 1 : 0,
      category: category_name,
      tax_category: p.tax_category,
      supplier_type: p.supplier_type,
      is_promo: p.is_promo ? 1 : 0,
      promo_price: p.promo_price,
      wholesale_price: p.wholesale_price,
      wholesale_threshold: p.wholesale_threshold,
      updated_at: p.updated_at,
    }
    return csvLine(headers.map((h) => value[h]))
  })

  const date = new Date().toISOString().slice(0, 10)
  return new Response([headers.join(","), ...lines].join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="products_${date}.csv"`,
      "cache-control": "no-store",
    },
  })
}
