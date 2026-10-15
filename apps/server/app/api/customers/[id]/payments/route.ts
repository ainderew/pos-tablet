// A store-credit payment recorded in the back office (no terminal, so not part of any drawer count)
import { NextResponse } from "next/server"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { PaymentSchema } from "@/lib/customers/input"
import { customerForUser } from "@/lib/customers/lookup"
import { recordBackOfficePayment } from "@/lib/customers/payment"
import { getDb } from "@/lib/db"
import { notFound, readJson } from "@/lib/http"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const customer = await customerForUser(db, auth.user, (await params).id)
  if (!customer) return notFound("Customer not found")
  const body = await readJson(request, PaymentSchema)
  if (!body.ok) return body.response

  const result = await recordBackOfficePayment(db, customer.id, auth.user.id, body.data)
  if (!result) return notFound("Customer not found")
  return NextResponse.json(result, { status: 201 })
}
