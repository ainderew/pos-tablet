// A customer's store-credit history (charges, payments, adjustments), oldest first
import { NextResponse } from "next/server"
import { asc, eq } from "drizzle-orm"
import { creditLedger, transactions } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { customerForUser } from "@/lib/customers/lookup"
import { getDb } from "@/lib/db"
import { notFound } from "@/lib/http"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const customer = await customerForUser(db, auth.user, (await params).id)
  if (!customer) return notFound("Customer not found")

  const rows = await db
    .select({ entry: creditLedger, invoice_number: transactions.invoice_number })
    .from(creditLedger)
    .leftJoin(transactions, eq(transactions.id, creditLedger.transaction_id))
    .where(eq(creditLedger.customer_id, customer.id))
    .orderBy(asc(creditLedger.created_at), asc(creditLedger.received_at), asc(creditLedger.id))
  return NextResponse.json({ entries: rows.map((r) => ({ ...r.entry, invoice_number: r.invoice_number })) })
}
