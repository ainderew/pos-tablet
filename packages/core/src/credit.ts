// Store-credit payments taken at the counter: POS-bir's POST /api/customers/payment as a pure
// function, minus two POS-bir bugs (negative amounts increased the debt; balances weren't rounded).
// Customer status belongs to the server: POS-bir un-blocked a customer whose balance fell back
// within the limit; the server applies that rule when the PAYMENT entry syncs.
import { roundMoney } from "./ph-tax"
import { PAYMENT_METHODS } from "./model"
import type { CashMovementRecord, CreditLedgerEntryRecord, PaymentMethod } from "./model"

export interface CreditPaymentContext {
  storeId: string
  terminalId: string
  /** The open shift; a CASH payment adds a CASH_IN to it */
  shiftId: string | null
  userId: string | null
  now: Date
  newId: () => string
}

export interface CreditPaymentRequest {
  customerId: string
  amount: number | string
  paymentMethod: PaymentMethod
  reference?: string | null
  notes?: string | null
}

export interface CreditPaymentData {
  /** The customer as this terminal knows them (balance includes its own unsynced entries) */
  customer: { id: string; full_name: string; current_debt_balance: number } | null
}

export type CreditPaymentErrorCode = "MISSING_FIELDS" | "INVALID_AMOUNT" | "INVALID_PAYMENT_METHOD" | "CUSTOMER_NOT_FOUND"

export interface CreditPaymentError {
  ok: false
  code: CreditPaymentErrorCode
  message: string
}

export interface CreditPaymentResult {
  ok: true
  ledgerEntry: CreditLedgerEntryRecord
  /** CASH_IN for a cash payment during a shift, so the drawer count expects it */
  cashMovement: CashMovementRecord | null
  /** May go below 0 when the customer overpays (the store then owes them) */
  customerBalanceAfter: number
}

export function buildCreditPayment(
  request: CreditPaymentRequest,
  data: CreditPaymentData,
  ctx: CreditPaymentContext
): CreditPaymentResult | CreditPaymentError {
  if (!request.customerId || !request.amount || !request.paymentMethod) {
    return { ok: false, code: "MISSING_FIELDS", message: "Missing required fields" }
  }
  const amount = roundMoney(Number(request.amount))
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Payment amount must be greater than zero" }
  }
  if (request.paymentMethod === "STORE_CREDIT" || !(PAYMENT_METHODS as readonly string[]).includes(request.paymentMethod)) {
    return { ok: false, code: "INVALID_PAYMENT_METHOD", message: `Can't pay store credit with ${request.paymentMethod}` }
  }
  const customer = data.customer
  if (!customer || customer.id !== request.customerId) {
    return { ok: false, code: "CUSTOMER_NOT_FOUND", message: "Customer not found" }
  }

  const base = () => ({
    id: ctx.newId(),
    store_id: ctx.storeId,
    terminal_id: ctx.terminalId,
    created_at: ctx.now.toISOString(),
  })
  const reference = request.reference || null
  const customerBalanceAfter = roundMoney(Number(customer.current_debt_balance) - amount)

  const ledgerEntry: CreditLedgerEntryRecord = {
    ...base(),
    customer_id: customer.id,
    transaction_id: null,
    shift_id: ctx.shiftId,
    entry_type: "PAYMENT",
    amount,
    running_balance: customerBalanceAfter,
    // Same wording as POS-bir, which the statement and customer history display
    notes: `Payment via ${request.paymentMethod} ${reference ? "(" + reference + ")" : ""}. ${request.notes || ""}`,
    payment_method: request.paymentMethod,
    reference_number: reference,
  }

  const cashMovement: CashMovementRecord | null =
    ctx.shiftId && request.paymentMethod === "CASH"
      ? {
          ...base(),
          shift_id: ctx.shiftId,
          user_id: ctx.userId,
          type: "CASH_IN",
          amount,
          reason: `Debt Payment - ${customer.full_name}`,
        }
      : null

  return { ok: true, ledgerEntry, cashMovement, customerBalanceAfter }
}
