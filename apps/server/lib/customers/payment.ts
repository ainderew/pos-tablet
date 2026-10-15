// A store-credit payment taken in the back office: a PAYMENT ledger entry with no terminal (so no
// device_seq) that says who recorded it, plus POS-bir's auto-unblock, in one transaction
import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { roundMoney } from "@pos/core"
import { creditLedger, customers } from "@pos/db"
import type { Db } from "@pos/db"
import type { z } from "zod"
import { currentBalance } from "./balance"
import type { PaymentSchema } from "./input"
import { paymentNotes } from "./input"
import { reloadCustomer } from "./lookup"

export async function recordBackOfficePayment(db: Db, customerId: string, userId: string, input: z.infer<typeof PaymentSchema>) {
  return db.transaction(async (tx) => {
    // Lock the customer, so payments (and a delete) for the same customer happen one at a time
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deleted_at)))
      .for("update")
    if (!customer) return null

    const balanceAfter = roundMoney((await currentBalance(tx, customer.id)) - input.amount)
    const [entry] = await tx
      .insert(creditLedger)
      .values({
        id: randomUUID(),
        store_id: customer.store_id,
        terminal_id: null,
        device_seq: null,
        created_by: userId,
        created_at: new Date(),
        customer_id: customer.id,
        transaction_id: null,
        shift_id: null,
        entry_type: "PAYMENT",
        amount: input.amount,
        running_balance: balanceAfter, // may go below 0 when the customer overpays
        notes: paymentNotes(input.payment_method, input.reference_number, input.notes),
        payment_method: input.payment_method,
        reference_number: input.reference_number ?? null,
      })
      .returning()

    // POS-bir's rule: a BLOCKED customer whose balance is back within the limit becomes ACTIVE
    if (customer.credit_status === "BLOCKED" && balanceAfter <= customer.credit_limit) {
      await tx.update(customers).set({ credit_status: "ACTIVE" }).where(eq(customers.id, customer.id))
    }
    const updated = await reloadCustomer(tx, customer.id)
    return { entry: { ...entry, invoice_number: null }, balance: updated.balance, customer: updated }
  })
}
