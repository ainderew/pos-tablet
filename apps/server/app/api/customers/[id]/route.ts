// One store-credit customer: profile, limit and status (edited here, synced down to the store's terminals)
import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { customers } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { currentBalance } from "@/lib/customers/balance"
import { UpdateCustomerSchema } from "@/lib/customers/input"
import { customerForUser, reloadCustomer } from "@/lib/customers/lookup"
import { getDb } from "@/lib/db"
import { errorResponse, notFound, readJson } from "@/lib/http"

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const customer = await customerForUser(getDb(), auth.user, (await params).id)
  if (!customer) return notFound("Customer not found")
  return NextResponse.json({ customer })
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const found = await customerForUser(db, auth.user, (await params).id)
  if (!found) return notFound("Customer not found")
  const body = await readJson(request, UpdateCustomerSchema)
  if (!body.ok) return body.response

  const changes = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined))
  const updated = await db
    .update(customers)
    .set(changes)
    .where(and(eq(customers.id, found.id), isNull(customers.deleted_at)))
    .returning({ id: customers.id })
  if (updated.length === 0) return notFound("Customer not found")
  return NextResponse.json({ customer: await reloadCustomer(db, found.id) })
}

export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const found = await customerForUser(db, auth.user, (await params).id)
  if (!found) return notFound("Customer not found")

  const result = await db.transaction(async (tx) => {
    // Locked like a payment, so a payment can't land between the balance check and the delete
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, found.id), isNull(customers.deleted_at)))
      .for("update")
    if (!customer) return "NOT_FOUND" as const
    const balance = await currentBalance(tx, customer.id)
    if (balance !== 0) return { balance }
    await tx.update(customers).set({ deleted_at: new Date() }).where(eq(customers.id, customer.id))
    return "DELETED" as const
  })
  if (result === "NOT_FOUND") return notFound("Customer not found")
  if (result !== "DELETED") {
    const owed = `₱${Math.abs(result.balance).toFixed(2)}`
    const message = result.balance > 0 ? `This customer still owes ${owed}` : `The store still owes this customer ${owed}`
    return errorResponse(409, "HAS_BALANCE", `${message}; settle the balance before deleting them`, { balance: result.balance })
  }
  return NextResponse.json({ ok: true })
}
