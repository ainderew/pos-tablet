// Store-credit payments taken at the counter: POS-bir's POST /api/customers/payment as a pure
// function, minus two POS-bir bugs (negative amounts increased the debt; balances weren't rounded).
// Customer status belongs to the server: POS-bir un-blocked a customer whose balance fell back
// within the limit; the server applies that rule when the PAYMENT entry syncs.
import { roundMoney } from "./ph-tax"
import { PAYMENT_METHODS } from "./model"
import type { CashMovementRecord, CreditLedgerEntryRecord, PaymentMethod, ShiftOpenRecord } from "./model"
import { recordBase } from "./record"
import type { RecordContext } from "./record"

export interface CreditPaymentContext extends RecordContext {
  userId: string | null
}

export interface CreditPaymentRequest {
  customerId: string
  amount: number | string
  paymentMethod: PaymentMethod
  reference?: string | null
  notes?: string | null
}

export interface CreditPaymentData {
  /**
   * This terminal's open shift: the payment counts toward its expected cash or e-wallet total.
   * Stricter than POS-bir, which also took payments outside a shift (cash then went unaccounted).
   */
  openShift: Pick<ShiftOpenRecord, "id" | "store_id" | "terminal_id"> | null
  /** The customer as this terminal knows them (balance includes its own unsynced entries) */
  customer: { id: string; full_name: string; current_debt_balance: number } | null
}

export type CreditPaymentErrorCode =
  | "NO_OPEN_SHIFT"
  | "MISSING_FIELDS"
  | "INVALID_AMOUNT"
  | "INVALID_PAYMENT_METHOD"
  | "CUSTOMER_NOT_FOUND"

export interface CreditPaymentError {
  ok: false
  code: CreditPaymentErrorCode
  message: string
}

export interface CreditPaymentResult {
  ok: true
  ledgerEntry: CreditLedgerEntryRecord
  /** CASH_IN for a cash payment, so the drawer count expects it */
  cashMovement: CashMovementRecord | null
  /** May go below 0 when the customer overpays (the store then owes them) */
  customerBalanceAfter: number
}

export function buildCreditPayment(
  request: CreditPaymentRequest,
  data: CreditPaymentData,
  ctx: CreditPaymentContext
): CreditPaymentResult | CreditPaymentError {
  const shift = data.openShift
  if (!shift || shift.terminal_id !== ctx.terminalId || shift.store_id !== ctx.storeId) {
    return { ok: false, code: "NO_OPEN_SHIFT", message: "Open a shift on this terminal before taking payments" }
  }
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

  const reference = request.reference || null
  const customerBalanceAfter = roundMoney(Number(customer.current_debt_balance) - amount)

  const ledgerEntry: CreditLedgerEntryRecord = {
    ...recordBase(ctx),
    customer_id: customer.id,
    transaction_id: null,
    shift_id: shift.id,
    entry_type: "PAYMENT",
    amount,
    running_balance: customerBalanceAfter,
    // Same wording as POS-bir, which the statement and customer history display
    notes: `Payment via ${request.paymentMethod} ${reference ? "(" + reference + ")" : ""}. ${request.notes || ""}`,
    payment_method: request.paymentMethod,
    reference_number: reference,
  }

  const cashMovement: CashMovementRecord | null =
    request.paymentMethod === "CASH"
      ? {
          ...recordBase(ctx),
          shift_id: shift.id,
          user_id: ctx.userId,
          type: "CASH_IN",
          amount,
          reason: `Debt Payment - ${customer.full_name}`,
        }
      : null

  return { ok: true, ledgerEntry, cashMovement, customerBalanceAfter }
}
