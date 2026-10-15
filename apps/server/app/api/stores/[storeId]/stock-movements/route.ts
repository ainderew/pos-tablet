// Back-office restocks and adjustments, and the store's movement history (terminals' included)
import { NextResponse } from "next/server"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { isThousandths } from "@pos/core"
import { stockMovements } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { productInOrg } from "@/lib/catalog/products"
import { BACK_OFFICE_REASONS, insertBackOfficeMovement, stockLevel } from "@/lib/catalog/stock"
import { invalidInput, MAX_QUANTITY, optionalText, round3, uuid, validQuantity } from "@/lib/catalog/validation"
import { getDb } from "@/lib/db"
import { notFound, readJson } from "@/lib/http"
import { isUuid, storeForUser } from "@/lib/stores"

type Params = { params: Promise<{ storeId: string }> }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** Newest first; ?product_id= for one product (deleted ones too), ?limit= up to 1000 (default 100) */
export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const url = new URL(request.url)

  const limitParam = url.searchParams.get("limit")
  const limit = limitParam === null || limitParam === "" ? DEFAULT_LIMIT : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return invalidInput([{ path: "limit", message: `A whole number from 1 to ${MAX_LIMIT}` }])
  }
  const productId = url.searchParams.get("product_id")
  if (productId !== null) {
    const product = isUuid(productId) ? await productInOrg(db, auth.user.org_id, productId, { includeDeleted: true }) : null
    if (!product) return notFound("Product not found")
  }

  const movements = await db
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.store_id, store.id), productId ? eq(stockMovements.product_id, productId) : undefined))
    .orderBy(desc(stockMovements.created_at), desc(stockMovements.received_at), desc(stockMovements.id))
    .limit(limit)
  return NextResponse.json({ movements })
}

const MovementSchema = z.object({
  product_id: uuid,
  quantity_delta: z
    .number()
    .refine((q) => q !== 0, "Must not be 0")
    .refine((q) => Math.abs(q) <= MAX_QUANTITY, "Too large")
    .refine(isThousandths, "At most 3 decimal places"),
  reason: z.enum(BACK_OFFICE_REASONS),
  note: optionalText(500).optional(),
})

export async function POST(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const body = await readJson(request, MovementSchema)
  if (!body.ok) return body.response

  const product = await productInOrg(db, auth.user.org_id, body.data.product_id)
  if (!product) return notFound("Product not found")
  const quantityDelta = round3(body.data.quantity_delta)
  if (!validQuantity(product.unit_type, quantityDelta)) {
    return invalidInput([{ path: "quantity_delta", message: "Must be a whole number for a QUANTITY product" }])
  }

  const result = await db.transaction(async (tx) => {
    const movement = await insertBackOfficeMovement(tx, {
      storeId: store.id,
      productId: product.id,
      userId: auth.user.id,
      quantityDelta,
      reason: body.data.reason,
      note: body.data.note,
    })
    return { movement, stock_level: await stockLevel(tx, store.id, product.id) }
  })
  return NextResponse.json(result, { status: 201 })
}
