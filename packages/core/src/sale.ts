// Builds a sale from a cart: the same rules, in the same order, as POS-bir's POST /api/transactions,
// as a pure function. The caller (tablet, server or PC data layer) supplies the current product
// rows, customer and open shift, saves the returned records in one local transaction, and queues
// them for sync. Where it is stricter than POS-bir, the comment says so.
import { calculateTransactionTotals, getActivePrice, roundMoney, toCents } from "./ph-tax"
import { isThousandths, PAYMENT_METHODS } from "./model"
import type {
  CreditLedgerEntryRecord,
  PaymentMethod,
  SaleRecord,
  ShiftOpenRecord,
  StockMovementRecord,
  TransactionItemRecord,
} from "./model"
import { recordBase } from "./record"
import type { RecordContext } from "./record"
import type { CartItem, Product } from "./types"

export interface SaleContext extends RecordContext {
  cashierId: string | null
  /** Next SI number to issue on this terminal (1 on a new terminal) */
  nextInvoiceNumber: number
}

export interface SaleLine {
  productId: string
  quantity: number
}

export interface SaleRequest {
  lines: SaleLine[]
  /** Net total the cashier was shown; if current prices give a different total, the sale is refused */
  expectedNetSales?: number
  paymentMethod?: PaymentMethod
  amountTendered?: number | string | null
  /** E-wallet/card reference, or the customer id for STORE_CREDIT */
  referenceNumber?: string | null
  paxCount?: number
  seniorCount?: number
  scPwd?: { idNumber?: string | null; name?: string | null } | null
}

export interface CreditCustomer {
  id: string
  credit_limit: number
  /** Balance as this terminal knows it, including its own unsynced ledger entries */
  current_debt_balance: number
  credit_status: "ACTIVE" | "BLOCKED" | "OVERDUE"
}

/**
 * Store credit while the terminal can't reach the server (the store's offline_credit_mode):
 * A = allowed up to the known balance (default); B = refused; C = allowed up to a per-customer cap
 * on charges made since the last sync.
 */
export interface OfflineCreditPolicy {
  mode: "A" | "B" | "C"
  offline: boolean
  /** Mode C: the most a customer may charge on this terminal between syncs */
  offlineCapPerCustomer?: number
  /** Mode C: what this customer has already charged here since the last sync */
  chargedSinceSync?: number
}

export interface SaleData {
  /** Current product rows; stock_level includes this terminal's unsynced stock movements */
  products: ReadonlyMap<string, Product>
  /** This terminal's open shift (see findOpenShift) */
  openShift: Pick<ShiftOpenRecord, "id" | "store_id" | "terminal_id"> | null
  /** The STORE_CREDIT customer, if found */
  customer?: CreditCustomer | null
  /**
   * "enforce" (default, as POS-bir) refuses a sale beyond local stock; "warn" allows it and reports
   * NEGATIVE_STOCK warnings, for stores whose back-office restocks may not have synced yet
   */
  stockPolicy?: "enforce" | "warn"
  creditPolicy?: OfflineCreditPolicy
}

export type SaleErrorCode =
  | "EMPTY_CART"
  | "NO_OPEN_SHIFT"
  | "INVALID_PAX"
  | "SC_PWD_ID_REQUIRED"
  | "INVALID_PAYMENT_METHOD"
  | "PRODUCT_UNAVAILABLE"
  | "INVALID_QUANTITY"
  | "PRICES_CHANGED"
  | "TENDER_SHORT"
  | "CUSTOMER_REQUIRED"
  | "CUSTOMER_NOT_FOUND"
  | "CUSTOMER_BLOCKED"
  | "CREDIT_LIMIT_EXCEEDED"
  | "STORE_CREDIT_OFFLINE"
  | "OFFLINE_CREDIT_CAP_EXCEEDED"
  | "INSUFFICIENT_STOCK"

export interface SaleError {
  ok: false
  code: SaleErrorCode
  message: string
  productId?: string
}

export interface SaleWarning {
  code: "NEGATIVE_STOCK"
  productId: string
  /** Local stock after this sale (below zero) */
  stockAfter: number
}

export interface SaleResult {
  ok: true
  transaction: SaleRecord
  items: TransactionItemRecord[]
  stockMovements: StockMovementRecord[]
  /** CHARGE entry for STORE_CREDIT sales */
  ledgerEntry: CreditLedgerEntryRecord | null
  customerBalanceAfter: number | null
  nextInvoiceNumber: number
  warnings: SaleWarning[]
}

const fail = (code: SaleErrorCode, message: string, productId?: string): SaleError => ({
  ok: false,
  code,
  message,
  ...(productId ? { productId } : {}),
})

export const formatDocumentNumber = (prefix: "SI" | "CN", n: number) => `${prefix}-${String(n).padStart(6, "0")}`

/** Whole thousandths, so weights compare exactly (0.7 kg - 0.4 kg leaves 0.3 kg, not 0.29999999999999993) */
const milli = (q: number) => Math.round(q * 1000)

export function buildSale(request: SaleRequest, data: SaleData, ctx: SaleContext): SaleResult | SaleError {
  const lines = request.lines ?? []
  if (lines.length === 0) return fail("EMPTY_CART", "Cart is empty")

  // Stricter than POS-bir, which didn't link sales to a shift (it summed shifts by time window)
  const shift = data.openShift
  if (!shift || shift.terminal_id !== ctx.terminalId || shift.store_id !== ctx.storeId) {
    return fail("NO_OPEN_SHIFT", "Open a shift on this terminal before selling")
  }

  // Stricter than POS-bir, which accepted these: more seniors than customers produces negative
  // VATable sales and an inflated exemption, and 0 customers produces NaN totals
  const paxCount = request.paxCount || 1 // 0 or missing means "not entered", as in POS-bir
  const seniorCount = request.seniorCount || 0
  if (!Number.isInteger(paxCount) || paxCount < 1 || !Number.isInteger(seniorCount) || seniorCount < 0 || seniorCount > paxCount) {
    return fail("INVALID_PAX", "Senior/PWD count must be between 0 and the number of customers")
  }
  // Stricter than POS-bir: the SC/PWD discount must name the ID it was granted against
  const scPwdId = request.scPwd?.idNumber?.trim() || null
  if (seniorCount > 0 && !scPwdId) return fail("SC_PWD_ID_REQUIRED", "Enter the SC/PWD ID for the discount")
  const paymentMethod: PaymentMethod = request.paymentMethod || "CASH"
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    return fail("INVALID_PAYMENT_METHOD", `Unknown payment method: ${paymentMethod}`)
  }

  // 1. Price every line from current product data
  const pricedCart: CartItem[] = []
  for (const line of lines) {
    const product = data.products.get(line.productId)
    if (!product) {
      return fail("PRODUCT_UNAVAILABLE", "A product is no longer available — remove it from the cart", line.productId)
    }
    const quantity = Number(line.quantity)
    // Stricter than POS-bir for weights: at most 3 decimals (grams), so stock sums stay exact
    const validQuantity = product.unit_type === "QUANTITY" ? Number.isInteger(quantity) : isThousandths(quantity)
    if (!(quantity > 0) || !validQuantity) {
      return fail("INVALID_QUANTITY", `Invalid quantity for ${product.name}`, product.id)
    }
    pricedCart.push({ product, quantity, active_price: getActivePrice(product, quantity) })
  }

  const totals = calculateTransactionTotals(pricedCart, paxCount, seniorCount)
  if (request.expectedNetSales !== undefined && toCents(totals.netSales) !== toCents(request.expectedNetSales)) {
    return fail("PRICES_CHANGED", "Prices changed — please refresh the cart")
  }

  // 2. Tender
  const tendered = parseFloat(String(request.amountTendered ?? ""))
  const amountTendered = Number.isFinite(tendered) && tendered !== 0 ? roundMoney(tendered) : null
  const change = amountTendered !== null ? roundMoney(amountTendered - totals.netSales) : 0
  if (paymentMethod === "CASH" && amountTendered !== null && toCents(amountTendered) < toCents(totals.netSales)) {
    return fail("TENDER_SHORT", "Amount tendered is less than the total due")
  }

  // 3. Store credit
  let customerBalanceAfter: number | null = null
  if (paymentMethod === "STORE_CREDIT") {
    if (!request.referenceNumber) return fail("CUSTOMER_REQUIRED", "Customer ID is required for Store Credit")
    const customer = data.customer
    if (!customer || customer.id !== request.referenceNumber) return fail("CUSTOMER_NOT_FOUND", "Customer not found")
    const limit = Number(customer.credit_limit)
    const newBalance = roundMoney(Number(customer.current_debt_balance) + totals.netSales)
    if (customer.credit_status === "BLOCKED") return fail("CUSTOMER_BLOCKED", "Customer account is BLOCKED")
    if (newBalance > limit) {
      return fail(
        "CREDIT_LIMIT_EXCEEDED",
        `Credit limit exceeded. Limit: ${limit.toFixed(2)}, New Balance: ${newBalance.toFixed(2)}`
      )
    }
    const policy = data.creditPolicy
    if (policy?.offline && policy.mode === "B") {
      return fail("STORE_CREDIT_OFFLINE", "Store credit is unavailable while offline")
    }
    if (policy?.offline && policy.mode === "C") {
      const charged = roundMoney((policy.chargedSinceSync ?? 0) + totals.netSales)
      if (toCents(charged) > toCents(policy.offlineCapPerCustomer ?? 0)) {
        return fail("OFFLINE_CREDIT_CAP_EXCEEDED", "This exceeds the store-credit allowed while offline")
      }
    }
    customerBalanceAfter = newBalance
  }

  // 4. Stock, in thousandths, tracked across lines in case a product appears twice
  const remaining = new Map<string, number>()
  const warnings: SaleWarning[] = []
  for (const item of pricedCart) {
    const available = remaining.get(item.product.id) ?? milli(Number(item.product.stock_level))
    const after = available - milli(item.quantity)
    if (after < 0) {
      if (data.stockPolicy !== "warn") {
        return fail("INSUFFICIENT_STOCK", `Insufficient stock for product: ${item.product.name}`, item.product.id)
      }
      warnings.push({ code: "NEGATIVE_STOCK", productId: item.product.id, stockAfter: after / 1000 })
    }
    remaining.set(item.product.id, after)
  }

  // 5. Records (one device_seq each, in this order)
  const transaction: SaleRecord = {
    ...recordBase(ctx),
    shift_id: shift.id,
    cashier_id: ctx.cashierId,
    invoice_number: formatDocumentNumber("SI", ctx.nextInvoiceNumber),
    transaction_type: "SALE",
    status: "PAID",
    original_transaction_id: null,
    void_reason: null,
    authorized_by: null,
    gross_sales: totals.grossSales,
    vatable_sales: totals.vatableSales,
    vat_amount: totals.vatAmount,
    vat_exempt_sales: totals.vatExemptSales,
    zero_rated_sales: totals.zeroRatedSales,
    total_discount: totals.totalDiscount,
    net_sales: totals.netSales,
    pax_count: paxCount,
    senior_count: seniorCount,
    sc_pwd_id: scPwdId,
    sc_pwd_name: request.scPwd?.name || null,
    payment_method: paymentMethod,
    amount_tendered: amountTendered,
    change_amount: change >= 0 ? change : 0,
    reference_number: request.referenceNumber || null,
  }

  const items: TransactionItemRecord[] = pricedCart.map((item) => ({
    ...recordBase(ctx),
    transaction_id: transaction.id,
    product_id: item.product.id,
    product_name: item.product.name,
    unit_type: item.product.unit_type,
    quantity_sold: item.quantity,
    price_at_sale: item.active_price!,
    cost_at_sale: Number(item.product.cost_price),
    tax_category: item.product.tax_category,
  }))

  const stockMovements: StockMovementRecord[] = pricedCart.map((item) => ({
    ...recordBase(ctx),
    product_id: item.product.id,
    quantity_delta: -item.quantity,
    reason: "SALE",
    ref_id: transaction.id,
    note: null,
  }))

  const ledgerEntry: CreditLedgerEntryRecord | null =
    customerBalanceAfter === null
      ? null
      : {
          ...recordBase(ctx),
          customer_id: request.referenceNumber!,
          transaction_id: transaction.id,
          shift_id: shift.id,
          entry_type: "CHARGE",
          amount: totals.netSales,
          running_balance: customerBalanceAfter,
          notes: null,
          payment_method: null,
          reference_number: null,
        }

  return {
    ok: true,
    transaction,
    items,
    stockMovements,
    ledgerEntry,
    customerBalanceAfter,
    nextInvoiceNumber: ctx.nextInvoiceNumber + 1,
    warnings,
  }
}
