// Builds a sale from a cart: the same rules, in the same order, as POS-bir's POST /api/transactions,
// as a pure function. The caller (tablet, server or PC data layer) supplies the current product
// rows and customer, saves the returned records in one local transaction, and queues them for sync.
import { calculateTransactionTotals, getActivePrice, roundMoney, toCents } from "./ph-tax"
import type {
  CreditLedgerEntryRecord,
  PaymentMethod,
  StockMovementRecord,
  TransactionItemRecord,
  TransactionRecord,
} from "./model"
import type { CartItem, Product } from "./types"

export interface SaleContext {
  storeId: string
  terminalId: string
  shiftId: string
  cashierId: string | null
  now: Date
  newId: () => string
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

export interface SaleData {
  /** Current product rows; stock_level includes this terminal's unsynced stock movements */
  products: ReadonlyMap<string, Product>
  /** The STORE_CREDIT customer, if found */
  customer?: CreditCustomer | null
}

export type SaleErrorCode =
  | "EMPTY_CART"
  | "PRODUCT_UNAVAILABLE"
  | "INVALID_QUANTITY"
  | "PRICES_CHANGED"
  | "TENDER_SHORT"
  | "CUSTOMER_REQUIRED"
  | "CUSTOMER_NOT_FOUND"
  | "CUSTOMER_BLOCKED"
  | "CREDIT_LIMIT_EXCEEDED"
  | "INSUFFICIENT_STOCK"

export interface SaleError {
  ok: false
  code: SaleErrorCode
  message: string
  productId?: string
}

export interface SaleResult {
  ok: true
  transaction: TransactionRecord
  items: TransactionItemRecord[]
  stockMovements: StockMovementRecord[]
  /** CHARGE entry for STORE_CREDIT sales */
  ledgerEntry: CreditLedgerEntryRecord | null
  customerBalanceAfter: number | null
  nextInvoiceNumber: number
}

const fail = (code: SaleErrorCode, message: string, productId?: string): SaleError => ({
  ok: false,
  code,
  message,
  ...(productId ? { productId } : {}),
})

export const formatDocumentNumber = (prefix: "SI" | "CN", n: number) => `${prefix}-${String(n).padStart(6, "0")}`

export function buildSale(request: SaleRequest, data: SaleData, ctx: SaleContext): SaleResult | SaleError {
  const lines = request.lines ?? []
  if (lines.length === 0) return fail("EMPTY_CART", "Cart is empty")

  // 1. Price every line from current product data
  const pricedCart: CartItem[] = []
  for (const line of lines) {
    const product = data.products.get(line.productId)
    if (!product) {
      return fail("PRODUCT_UNAVAILABLE", "A product is no longer available — remove it from the cart", line.productId)
    }
    const quantity = Number(line.quantity)
    if (!(quantity > 0) || (product.unit_type === "QUANTITY" && !Number.isInteger(quantity))) {
      return fail("INVALID_QUANTITY", `Invalid quantity for ${product.name}`, product.id)
    }
    pricedCart.push({ product, quantity, active_price: getActivePrice(product, quantity) })
  }

  const paxCount = request.paxCount || 1
  const seniorCount = request.seniorCount || 0
  const totals = calculateTransactionTotals(pricedCart, paxCount, seniorCount)
  if (request.expectedNetSales !== undefined && toCents(totals.netSales) !== toCents(request.expectedNetSales)) {
    return fail("PRICES_CHANGED", "Prices changed — please refresh the cart")
  }

  // 2. Tender
  const paymentMethod: PaymentMethod = request.paymentMethod || "CASH"
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
    customerBalanceAfter = newBalance
  }

  // 4. Stock (tracked across lines, in case a product appears twice)
  const remaining = new Map<string, number>()
  for (const item of pricedCart) {
    const available = remaining.get(item.product.id) ?? Number(item.product.stock_level)
    if (!(available >= item.quantity)) {
      return fail("INSUFFICIENT_STOCK", `Insufficient stock for product: ${item.product.name}`, item.product.id)
    }
    remaining.set(item.product.id, available - item.quantity)
  }

  // 5. Records
  const base = () => ({
    id: ctx.newId(),
    store_id: ctx.storeId,
    terminal_id: ctx.terminalId,
    created_at: ctx.now.toISOString(),
  })

  const transaction: TransactionRecord = {
    ...base(),
    shift_id: ctx.shiftId,
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
    sc_pwd_id: request.scPwd?.idNumber || null,
    sc_pwd_name: request.scPwd?.name || null,
    payment_method: paymentMethod,
    amount_tendered: amountTendered,
    change_amount: change >= 0 ? change : 0,
    reference_number: request.referenceNumber || null,
  }

  const items: TransactionItemRecord[] = pricedCart.map((item) => ({
    ...base(),
    transaction_id: transaction.id,
    product_id: item.product.id,
    product_name: item.product.name,
    quantity_sold: item.quantity,
    price_at_sale: item.active_price!,
    cost_at_sale: Number(item.product.cost_price),
    tax_category: item.product.tax_category,
  }))

  const stockMovements: StockMovementRecord[] = pricedCart.map((item) => ({
    ...base(),
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
          ...base(),
          customer_id: request.referenceNumber!,
          transaction_id: transaction.id,
          shift_id: ctx.shiftId,
          entry_type: "CHARGE",
          amount: totals.netSales,
          running_balance: customerBalanceAfter,
          notes: null,
        }

  return {
    ok: true,
    transaction,
    items,
    stockMovements,
    ledgerEntry,
    customerBalanceAfter,
    nextInvoiceNumber: ctx.nextInvoiceNumber + 1,
  }
}
