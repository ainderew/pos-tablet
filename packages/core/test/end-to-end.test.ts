// One terminal through two shifts, a Z-reading and a clock reset, using every builder's real
// output as the next builder's input (no hand-built records). Checks that the pieces agree with each
// other: drawer counts vs the Z, stock, store-credit balance, receipts, device_seq and the schemas.
import { describe, expect, it } from "vitest"
import {
  AuditLogRecordSchema,
  buildCashMovement,
  buildCreditPayment,
  buildPaymentReceipt,
  buildSale,
  buildSaleReceipt,
  buildShiftOpen,
  buildStatementOfAccount,
  buildVoid,
  buildVoidSlip,
  CashMovementRecordSchema,
  computeShiftClose,
  computeZReading,
  CreditLedgerEntryRecordSchema,
  findOpenShift,
  renderReceiptEscPos,
  renderReceiptHtml,
  roundMoney,
  ShiftCloseRecordSchema,
  ShiftOpenRecordSchema,
  StockMovementRecordSchema,
  sumQuantities,
  terminalCounters,
  toCents,
  TransactionItemRecordSchema,
  TransactionRecordSchema,
  ZReadingRecordSchema,
} from "../src"
import type {
  AuditLogRecord,
  CashMovementRecord,
  CreditLedgerEntryRecord,
  Product,
  SaleRequest,
  ShiftCloseRecord,
  ShiftOpenRecord,
  StockMovementRecord,
  TransactionItemRecord,
  TransactionRecord,
  ZReadingRecord,
} from "../src"

const product = (id: string, o: Partial<Product>): Product => ({
  id, name: id, barcode: null, selling_price: 100, cost_price: 50, stock_level: 100, unit_type: "QUANTITY",
  low_stock_threshold: 0, notify_low_stock: false, category_id: null, tax_category: "VATABLE", supplier_type: "WHOLESALER",
  is_promo: false, promo_price: null, wholesale_price: null, wholesale_threshold: 0, pos_id: "x", is_synced: false, ...o,
})

/** A terminal's local database: append-only record lists plus the counters it persists */
class Terminal {
  readonly storeId = "store-1"
  readonly terminalId = "terminal-1"
  now = new Date("2026-10-15T00:00:00.000Z")
  private ids = 0
  private seq = 0
  nextInvoice = 1
  nextCreditNote = 1
  transactions: TransactionRecord[] = []
  items: TransactionItemRecord[] = []
  stock: StockMovementRecord[] = []
  ledger: CreditLedgerEntryRecord[] = []
  opens: ShiftOpenRecord[] = []
  closes: ShiftCloseRecord[] = []
  cash: CashMovementRecord[] = []
  audits: AuditLogRecord[] = []
  zs: ZReadingRecord[] = []
  readonly products = [
    product("soap", { name: "Laundry Soap", selling_price: 25, cost_price: 18, stock_level: 50, wholesale_price: 21, wholesale_threshold: 12 }),
    product("eggs", { name: "Fresh Eggs", selling_price: 8.75, cost_price: 7, stock_level: 100, tax_category: "VAT_EXEMPT" }),
    product("rice", { name: "Rice", selling_price: 52.5, cost_price: 45, stock_level: 20, unit_type: "WEIGHT" }),
    product("fifty", { name: "Fifty Item", selling_price: 50, cost_price: 30, stock_level: 40 }),
    product("export", { name: "Export Item", selling_price: 120, cost_price: 90, stock_level: 10, tax_category: "ZERO_RATED" }),
  ]
  readonly customer = { id: "rosa", full_name: "Aling Rosa", credit_limit: 1000, credit_status: "ACTIVE" as const }

  tick(minutes: number) {
    this.now = new Date(this.now.getTime() + minutes * 60_000)
  }
  ctx(userId = "cashier-1") {
    return {
      storeId: this.storeId,
      terminalId: this.terminalId,
      now: this.now,
      newId: () => `r${++this.ids}`,
      nextSeq: () => ++this.seq,
      cashierId: userId,
      userId,
    }
  }
  /** Local stock = opening stock + this terminal's movements, summed in thousandths */
  stockOf(id: string) {
    const base = this.products.find((p) => p.id === id)!.stock_level
    return sumQuantities(base, ...this.stock.filter((m) => m.product_id === id).map((m) => m.quantity_delta))
  }
  productMap() {
    return new Map(this.products.map((p) => [p.id, { ...p, stock_level: this.stockOf(p.id) }]))
  }
  balance() {
    return roundMoney(this.ledger.reduce((sum, e) => sum + (e.entry_type === "CHARGE" ? e.amount : -e.amount), 0))
  }
  openShift() {
    return findOpenShift(this.opens, this.closes, this.terminalId)
  }
  counters() {
    return terminalCounters(this.zs.at(-1) ?? null, 0)
  }
  open(openingFund: number) {
    const r = buildShiftOpen({ openingFund }, { user: { id: "cashier-1", is_active: true }, openShift: this.openShift(), counters: this.counters() }, this.ctx())
    if (!r.ok) throw new Error(r.code)
    this.opens.push(r.shift)
    return r.shift
  }
  sell(request: SaleRequest) {
    const r = buildSale(
      request,
      {
        products: this.productMap(),
        openShift: this.openShift(),
        customer: { ...this.customer, current_debt_balance: this.balance() },
      },
      { ...this.ctx(), nextInvoiceNumber: this.nextInvoice }
    )
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    this.nextInvoice = r.nextInvoiceNumber
    this.transactions.push(r.transaction)
    this.items.push(...r.items)
    this.stock.push(...r.stockMovements)
    if (r.ledgerEntry) this.ledger.push(r.ledgerEntry)
    return r
  }
  void(sale: TransactionRecord) {
    const r = buildVoid(
      { authorizedBy: "manager-1", reason: "Customer returned it" },
      {
        openShift: this.openShift(),
        original: sale,
        items: this.items.filter((i) => i.transaction_id === sale.id),
        alreadyVoided: this.transactions.some((t) => t.original_transaction_id === sale.id),
        customer: { id: this.customer.id, current_debt_balance: this.balance() },
      },
      { ...this.ctx(), nextCreditNoteNumber: this.nextCreditNote }
    )
    if (!r.ok) throw new Error(r.code)
    this.nextCreditNote = r.nextCreditNoteNumber
    this.transactions.push(r.creditNote)
    this.stock.push(...r.stockMovements)
    if (r.ledgerEntry) this.ledger.push(r.ledgerEntry)
    this.audits.push(r.auditLog)
    return r
  }
  pay(amount: number, paymentMethod: "CASH" | "GCASH", reference: string | null = null) {
    const r = buildCreditPayment(
      { customerId: this.customer.id, amount, paymentMethod, reference },
      { openShift: this.openShift(), customer: { ...this.customer, current_debt_balance: this.balance() } },
      this.ctx()
    )
    if (!r.ok) throw new Error(r.code)
    this.ledger.push(r.ledgerEntry)
    if (r.cashMovement) this.cash.push(r.cashMovement)
    return r
  }
  cashMovement(type: string, amount: number, reason: string) {
    const r = buildCashMovement({ type, amount, reason }, { openShift: this.openShift() }, this.ctx())
    if (!r.ok) throw new Error(r.code)
    this.cash.push(r.movement)
  }
  close(actual: { actualCash: number; actualGcash?: number; actualMaya?: number }) {
    const r = computeShiftClose(
      actual,
      {
        shift: this.openShift(),
        closes: this.closes,
        transactions: this.transactions,
        cashMovements: this.cash,
        creditLedgerEntries: this.ledger,
        counters: this.counters(),
      },
      this.ctx()
    )
    if (!r.ok) throw new Error(r.code)
    this.closes.push(r.close)
    return r
  }
  zReading() {
    const r = computeZReading(
      {
        transactions: this.transactions,
        shiftOpens: this.opens,
        cashMovements: this.cash,
        previous: this.zs.at(-1) ?? null,
        openingGrandTotal: 0,
      },
      this.ctx("manager-1")
    )
    if (!r.ok) throw new Error(r.code)
    this.zs.push(r.reading)
    return r.reading
  }
  allRecords() {
    return [...this.transactions, ...this.items, ...this.stock, ...this.ledger, ...this.opens, ...this.closes, ...this.cash, ...this.audits, ...this.zs]
  }
}

const net = (records: TransactionRecord[]) => roundMoney(records.reduce((s, t) => s + t.net_sales, 0))

describe("a terminal's day, end to end", () => {
  const t = new Terminal()

  // Shift A: four sales, a cash-out, two debt payments
  t.open(1000)
  t.tick(5)
  const cashSale = t.sell({ lines: [{ productId: "soap", quantity: 3 }], amountTendered: 100 }).transaction
  t.tick(5)
  const gcashSale = t.sell({ lines: [{ productId: "eggs", quantity: 10 }, { productId: "rice", quantity: 1.5 }], paymentMethod: "GCASH", referenceNumber: "GC-1" }).transaction
  t.tick(5)
  const creditSale = t.sell({ lines: [{ productId: "fifty", quantity: 4 }], paymentMethod: "STORE_CREDIT", referenceNumber: "rosa" }).transaction
  t.tick(5)
  const scSale = t.sell({
    lines: [{ productId: "fifty", quantity: 2 }, { productId: "export", quantity: 1 }],
    paxCount: 2,
    seniorCount: 1,
    scPwd: { idNumber: "SC-123", name: "Lolo Ben" },
    amountTendered: 500,
  }).transaction
  t.tick(5)
  t.cashMovement("CASH_OUT", 50, "Ice for the cooler")
  t.tick(5)
  const gcashPayment = t.pay(50, "GCASH", "GC-PAY-1").ledgerEntry
  t.tick(5)
  t.pay(30, "CASH")
  const expectedCashA = roundMoney(1000 + cashSale.net_sales + scSale.net_sales - 50 + 30)
  const expectedGcashA = roundMoney(gcashSale.net_sales + 50)
  t.tick(60)
  const closeA = t.close({ actualCash: expectedCashA, actualGcash: expectedGcashA })

  // Shift B: void the cash sale and the store-credit sale from shift A, one Maya sale
  t.tick(30)
  t.open(500)
  t.tick(5)
  const voidCash = t.void(cashSale)
  t.tick(5)
  const voidCredit = t.void(creditSale)
  t.tick(5)
  const mayaSale = t.sell({ lines: [{ productId: "soap", quantity: 12 }], paymentMethod: "MAYA", referenceNumber: "MY-9" }).transaction
  const expectedCashB = roundMoney(500 - cashSale.net_sales) // the voided cash sale is refunded from this drawer
  t.tick(60)
  const closeB = t.close({ actualCash: expectedCashB, actualMaya: mayaSale.net_sales })

  t.tick(5)
  const z1 = t.zReading()

  it("balances each drawer: expected amounts include sales, refunds, cash movements and debt payments", () => {
    expect(closeA.close).toMatchObject({ theoretical_cash: expectedCashA, theoretical_gcash: expectedGcashA, variance: 0 })
    expect(closeA.creditPayments).toEqual({ gcash: 50, maya: 0, card: 0 })
    expect(closeB.close).toMatchObject({ theoretical_cash: expectedCashB, theoretical_maya: mayaSale.net_sales, variance: 0 })
  })

  it("Z-reading agrees with the sales, the credit notes and the drawer counts", () => {
    const sales = t.transactions.filter((x) => x.transaction_type === "SALE")
    const creditNotes = t.transactions.filter((x) => x.transaction_type === "VOID_REFUND")
    expect(z1).toMatchObject({
      z_counter: 1,
      sales_count: 5,
      void_count: 2,
      sales_total: net(sales),
      void_total: -net(creditNotes),
      net_total: net(t.transactions),
      beginning_grand_total: 0,
      accumulated_grand_total: net(t.transactions),
      beginning_invoice: "SI-000001",
      ending_invoice: "SI-000005",
      beginning_credit_note: "CN-000001",
      ending_credit_note: "CN-000002",
    })
    expect(toCents(z1.theoretical_cash)).toBe(toCents(closeA.close.theoretical_cash) + toCents(closeB.close.theoretical_cash))
    expect(z1.net_total).toBe(roundMoney(gcashSale.net_sales + scSale.net_sales + mayaSale.net_sales))
  })

  it("stock and the customer's balance follow every sale, void and payment", () => {
    expect(t.stockOf("soap")).toBe(50 - 3 + 3 - 12)
    expect(t.stockOf("fifty")).toBe(40 - 4 + 4 - 2)
    expect(t.stockOf("rice")).toBe(18.5)
    // 200 charged, 50 + 30 paid, the 200 charge voided: the store now owes Aling Rosa 80
    expect(t.balance()).toBe(-80)
    expect(t.ledger.at(-1)!.running_balance).toBe(-80)
    expect(voidCredit.customerBalanceAfter).toBe(-80)
  })

  it("prints receipts whose numbers add up", () => {
    const sale = buildSaleReceipt(scSale, t.items.filter((i) => i.transaction_id === scSale.id), { businessName: "General Store" }, { cashierName: "Ana" })
    const total = (label: string) => sale.totals.find((r) => r.label === label)?.value as number
    expect(toCents(total("Subtotal")) - toCents(total("Less VAT (SC/PWD)")) - toCents(total("Less Discount"))).toBe(toCents(total("TOTAL")))
    expect(renderReceiptHtml(sale)).toContain("SC-123")
    for (const width of [58, 80] as const) expect(renderReceiptEscPos(sale, { paperWidth: width, cut: true }).length).toBeGreaterThan(100)

    const slip = buildVoidSlip(voidCash.creditNote, cashSale, t.items.filter((i) => i.transaction_id === cashSale.id), {}, { authorizedByName: "Manager" })
    expect(renderReceiptHtml(slip)).toContain("CN-000001")

    const payment = buildPaymentReceipt({ full_name: t.customer.full_name, id: t.customer.id }, gcashPayment, {}, { receiptNumber: "PR-000001" })
    expect(renderReceiptHtml(payment)).toContain("GC-PAY-1")

    const statement = buildStatementOfAccount({ full_name: t.customer.full_name, id: t.customer.id }, t.ledger, {}, { now: t.now, statementNumber: "SOA-000001" })
    const lines = statement.items.reduce((sum, i) => sum + toCents(i.lineTotal), 0)
    expect(lines).toBe(toCents(t.balance()))
  })

  it("every record is valid for sync, belongs to this terminal, and has a unique device_seq", () => {
    const all = t.allRecords()
    for (const x of t.transactions) TransactionRecordSchema.parse(x)
    for (const x of t.items) TransactionItemRecordSchema.parse(x)
    for (const x of t.stock) StockMovementRecordSchema.parse(x)
    for (const x of t.ledger) CreditLedgerEntryRecordSchema.parse(x)
    for (const x of t.opens) ShiftOpenRecordSchema.parse(x)
    for (const x of t.closes) ShiftCloseRecordSchema.parse(x)
    for (const x of t.cash) CashMovementRecordSchema.parse(x)
    for (const x of t.audits) AuditLogRecordSchema.parse(x)
    for (const x of t.zs) ZReadingRecordSchema.parse(x)
    expect(all.every((r) => r.terminal_id === "terminal-1" && r.store_id === "store-1")).toBe(true)
    const seqs = all.map((r) => r.device_seq).sort((a, b) => a - b)
    expect(seqs).toEqual(seqs.map((_, k) => k + 1))
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
  })

  it("a clock reset after the Z can't drop a sale from the next Z or the grand total", () => {
    t.now = new Date("2026-01-01T00:00:00.000Z") // battery died; the tablet boots with an old date
    t.open(200)
    const lost = t.sell({ lines: [{ productId: "eggs", quantity: 4 }], amountTendered: 35 }).transaction
    expect(lost.created_at < z1.created_at).toBe(true)
    t.close({ actualCash: roundMoney(200 + lost.net_sales) })
    t.now = new Date("2026-10-16T08:00:00.000Z") // clock fixed
    const z2 = t.zReading()
    expect(z2).toMatchObject({
      z_counter: 2,
      sales_count: 1,
      net_total: lost.net_sales,
      beginning_grand_total: z1.accumulated_grand_total,
      accumulated_grand_total: roundMoney(z1.accumulated_grand_total + lost.net_sales),
      beginning_invoice: "SI-000006",
    })
  })
})
