// Stock levels in one store: the sum of its stock movements
import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { products } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { productInOrg, productOrder } from "@/lib/catalog/products"
import { stockLevel, stockLevels } from "@/lib/catalog/stock"
import { flag } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { notFound } from "@/lib/http"
import { isUuid, storeForUser } from "@/lib/stores"

type Params = { params: Promise<{ storeId: string }> }

/** ?product_id= for one product (deleted ones too); otherwise every active product of the catalog */
export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const url = new URL(request.url)
  const productId = url.searchParams.get("product_id")

  if (productId !== null) {
    const product = isUuid(productId) ? await productInOrg(db, auth.user.org_id, productId, { includeDeleted: true }) : null
    if (!product) return notFound("Product not found")
    return NextResponse.json({ stock: [{ product_id: product.id, stock_level: await stockLevel(db, store.id, product.id) }] })
  }

  const catalog = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.org_id, auth.user.org_id), flag(url, "include_deleted") ? undefined : isNull(products.deleted_at)))
    .orderBy(...productOrder)
  const levels = await stockLevels(db, store.id)
  return NextResponse.json({ stock: catalog.map((p) => ({ product_id: p.id, stock_level: levels.get(p.id) ?? 0 })) })
}
