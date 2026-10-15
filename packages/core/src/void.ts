// Voids a sale by issuing a credit note: POS-bir's POST /api/transactions/void as a pure function.
// The original sale is never edited (records are append-only); it reads as VOIDED because a credit
// note references it. Manager PIN verification happens in the caller before this runs.
import { roundMoney } from "./ph-tax"
import type {
  AuditLogRecord,
  CreditLedgerEntryRecord,
  StockMovementRecord,
  TransactionItemRecord,
  TransactionRecord,
} from "./model"
import { formatDocumentNumber } from "./sale"

export interface VoidContext {
  storeId: string
  terminalId: string
  /** The shift the void happens in (can differ from the sale's), so its expected cash goes down */
  shiftId: string
  cashierId: string | null
  now: Date
  newId: () => string
  /** Next CN number to issue on this terminal (1 on a new terminal); separate from SI numbers */
  nextCreditNoteNumber: number
}

export interface VoidRequest {
  /** Manager who approved the void (already verified by the caller) */
  authorizedBy: string
  reason: string | null
  /** Audit photo in the media queue, if one was taken */
  auditImageId?: string | null
}

export interface VoidData {
  original: TransactionRecord
  /** The original sale's lines */
  items: TransactionItemRecord[]
  /** True when a credit note already references this sale */
  alreadyVoided: boolean
  /** For STORE_CREDIT sales: the customer as this terminal knows them */
  customer?: { id: string; current_debt_balance: number } | null
}

export type VoidErrorCode = "ALREADY_VOIDED" | "NOT_A_SALE" | "CUSTOMER_NOT_FOUND"

export interface VoidError {
  ok: false
  code: VoidErrorCode
  message: string
}

export interface VoidResult {
  ok: true
  creditNote: TransactionRecord
  stockMovements: StockMovementRecord[]
  /** ADJUSTMENT entry reversing a STORE_CREDIT charge */
  ledgerEntry: CreditLedgerEntryRecord | null
  customerBalanceAfter: number | null
  auditLog: AuditLogRecord
  nextCreditNoteNumber: number
}

// Negate without producing -0 (which isn't equal to 0 for Object.is / toEqual)
const negate = (amount: number) => (amount === 0 ? 0 : -amount)

export function buildVoid(request: VoidRequest, data: VoidData, ctx: VoidContext): VoidResult | VoidError {
  const original = data.original
  if (data.alreadyVoided) return { ok: false, code: "ALREADY_VOIDED", message: "Transaction is already voided" }
  if (original.status !== "PAID" || original.transaction_type !== "SALE") {
    return { ok: false, code: "NOT_A_SALE", message: "Only completed sales can be voided" }
  }

  const isStoreCredit = original.payment_method === "STORE_CREDIT" && !!original.reference_number
  if (isStoreCredit && (!data.customer || data.customer.id !== original.reference_number)) {
    return { ok: false, code: "CUSTOMER_NOT_FOUND", message: "Customer for store credit sale not found" }
  }

  const base = () => ({
    id: ctx.newId(),
    store_id: ctx.storeId,
    terminal_id: ctx.terminalId,
    created_at: ctx.now.toISOString(),
  })
  const reason = request.reason ?? null
  const creditNoteNumber = formatDocumentNumber("CN", ctx.nextCreditNoteNumber)

  const creditNote: TransactionRecord = {
    ...base(),
    shift_id: ctx.shiftId,
    cashier_id: ctx.cashierId,
    invoice_number: creditNoteNumber,
    transaction_type: "VOID_REFUND",
    status: "REFUND",
    original_transaction_id: original.id,
    void_reason: reason,
    authorized_by: request.authorizedBy,
    gross_sales: negate(original.gross_sales),
    vatable_sales: negate(original.vatable_sales),
    vat_amount: negate(original.vat_amount),
    vat_exempt_sales: negate(original.vat_exempt_sales),
    zero_rated_sales: negate(original.zero_rated_sales),
    total_discount: negate(original.total_discount),
    net_sales: negate(original.net_sales),
    pax_count: original.pax_count,
    senior_count: original.senior_count,
    sc_pwd_id: original.sc_pwd_id,
    sc_pwd_name: original.sc_pwd_name,
    payment_method: original.payment_method,
    amount_tendered: 0, // no tender or change on a void
    change_amount: 0,
    reference_number: original.invoice_number,
  }

  // Every line of the voided sale goes back into stock
  const stockMovements: StockMovementRecord[] = data.items
    .filter((item) => item.transaction_id === original.id)
    .map((item) => ({
      ...base(),
      product_id: item.product_id,
      quantity_delta: item.quantity_sold,
      reason: "VOID",
      ref_id: creditNote.id,
      note: null,
    }))

  // Reverse a store-credit charge; the balance may go negative (the store then owes the customer)
  let ledgerEntry: CreditLedgerEntryRecord | null = null
  let customerBalanceAfter: number | null = null
  if (isStoreCredit) {
    const amount = Number(original.net_sales)
    customerBalanceAfter = roundMoney(Number(data.customer!.current_debt_balance) - amount)
    ledgerEntry = {
      ...base(),
      customer_id: original.reference_number!,
      transaction_id: creditNote.id,
      shift_id: ctx.shiftId,
      entry_type: "ADJUSTMENT",
      amount,
      running_balance: customerBalanceAfter,
      notes: `Void of ${original.invoice_number} (${creditNoteNumber})${reason ? `: ${reason}` : ""}`,
      payment_method: null,
      reference_number: null,
    }
  }

  const auditLog: AuditLogRecord = {
    ...base(),
    action_type: "TRANSACTION_VOID",
    user_id: request.authorizedBy,
    shift_id: ctx.shiftId,
    metadata: { original_invoice: original.invoice_number, reversal_invoice: creditNoteNumber, reason },
    audit_image_id: request.auditImageId ?? null,
  }

  return {
    ok: true,
    creditNote,
    stockMovements,
    ledgerEntry,
    customerBalanceAfter,
    auditLog,
    nextCreditNoteNumber: ctx.nextCreditNoteNumber + 1,
  }
}
