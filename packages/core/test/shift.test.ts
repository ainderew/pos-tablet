// Shift rules beyond what the POS-bir fixture reaches: several terminals, shift linkage of credit
// notes and debt payments, centavo sums, creation order over the clock, and the input checks core adds.
import { describe, expect, it } from "vitest"
import { CashMovementRecordSchema, ShiftCloseRecordSchema, ShiftOpenRecordSchema } from "../src/model"
import type { CashMovementRecord, CreditLedgerEntryRecord, CreditNoteRecord, SaleRecord, ShiftOpenRecord } from "../src/model"
import { buildCreditPayment } from "../src/credit"
import { buildCashMovement, buildShiftOpen, computeShiftClose, findOpenShift } from "../src/shift"
import type { ShiftCloseData, ShiftContext, ShiftOpenData } from "../src/shift"

const T1 = "terminal-1"
const T2 = "terminal-2"
const NOW = "2026-10-15T08:00:00.000Z"
const COUNTERS = { zCounter: 7, grandTotal: 12345.67 }
let n = 0

/** A context whose counters are visible, so tests can check what a call took */
function context(o: Partial<ShiftContext> = {}) {
  const taken = { ids: 0, seqs: 0 }
  const ctx: ShiftContext = {
    storeId: "store-1",
    terminalId: T1,
    userId: "user-1",
    now: new Date(NOW),
    newId: () => `new-${++taken.ids}`,
    nextSeq: () => 500 + ++taken.seqs,
    ...o,
  }
  return { ctx, taken }
}
const ctx = (o: Partial<ShiftContext> = {}) => context(o).ctx
/** What every record built with context() carries */
const identity = { id: "new-1", store_id: "store-1", terminal_id: T1, device_seq: 501, created_at: NOW }

const base = (o: { terminal_id?: string; device_seq?: number; created_at?: string } = {}) => ({
  id: `rec-${++n}`,
  store_id: "store-1",
  terminal_id: o.terminal_id ?? T1,
  device_seq: o.device_seq ?? ++n,
  created_at: o.created_at ?? "2026-10-15T01:00:00.000Z",
})

const shiftOpen = (o: Partial<ShiftOpenRecord> = {}): ShiftOpenRecord => ({
  ...base(o),
  id: "shift-1",
  user_id: "user-1",
  opening_fund: 1000,
  snapshot_z_counter: 7,
  snapshot_accumulated_total: 12345.67,
  ...o,
})

const sale = (o: Partial<SaleRecord> = {}): SaleRecord => ({
  ...base(o),
  shift_id: "shift-1",
  cashier_id: null,
  invoice_number: `SI-${String(++n).padStart(6, "0")}`,
  transaction_type: "SALE",
  status: "PAID",
  original_transaction_id: null,
  void_reason: null,
  authorized_by: null,
  gross_sales: 100,
  vatable_sales: 89.29,
  vat_amount: 10.71,
  vat_exempt_sales: 0,
  zero_rated_sales: 0,
  total_discount: 0,
  net_sales: 100,
  pax_count: 1,
  senior_count: 0,
  sc_pwd_id: null,
  sc_pwd_name: null,
  payment_method: "CASH",
  amount_tendered: null,
  change_amount: 0,
  reference_number: null,
  ...o,
})

/** A credit note for `original`, issued in `shiftId` (as buildVoid does: the shift doing the void) */
const creditNote = (original: SaleRecord, shiftId: string): CreditNoteRecord => ({
  ...sale(),
  shift_id: shiftId,
  invoice_number: `CN-${String(++n).padStart(6, "0")}`,
  transaction_type: "VOID_REFUND",
  status: "REFUND",
  original_transaction_id: original.id,
  void_reason: "Void",
  authorized_by: "mgr",
  gross_sales: -original.gross_sales,
  vatable_sales: -original.vatable_sales,
  vat_amount: -original.vat_amount,
  net_sales: -original.net_sales,
  payment_method: original.payment_method,
  amount_tendered: 0,
  change_amount: 0,
  reference_number: original.invoice_number,
})

const movement = (o: Partial<CashMovementRecord> = {}): CashMovementRecord => ({
  ...base(o),
  shift_id: "shift-1",
  user_id: null,
  type: "CASH_IN",
  amount: 100,
  reason: "Change fund",
  ...o,
})

const ledgerEntry = (o: Partial<CreditLedgerEntryRecord> = {}): CreditLedgerEntryRecord => ({
  ...base(o),
  customer_id: "rosa",
  transaction_id: null,
  shift_id: "shift-1",
  entry_type: "PAYMENT",
  amount: 100,
  running_balance: 0,
  notes: null,
  payment_method: "GCASH",
  reference_number: "GC-1",
  ...o,
})

describe("findOpenShift", () => {
  it("returns this terminal's latest-created shift without a close record, whatever the clock said", () => {
    const opens = [
      shiftOpen({ id: "a", device_seq: 10, created_at: "2026-10-15T09:00:00.000Z" }),
      shiftOpen({ id: "b", device_seq: 20, created_at: "2026-10-15T07:00:00.000Z" }), // clock was set back
      shiftOpen({ id: "c", device_seq: 30, created_at: "2026-10-15T08:00:00.000Z" }),
      shiftOpen({ id: "other", terminal_id: T2, device_seq: 99 }),
    ]
    expect(findOpenShift(opens, [{ shift_id: "c" }], T1)?.id).toBe("b")
    expect(findOpenShift(opens, [], T1)?.id).toBe("c")
    expect(findOpenShift(opens, [{ shift_id: "a" }, { shift_id: "b" }, { shift_id: "c" }], T1)).toBeNull()
    expect(findOpenShift(opens, [], T2)?.id).toBe("other")
  })
})

describe("buildShiftOpen", () => {
  const data = (o: Partial<ShiftOpenData> = {}): ShiftOpenData => ({
    user: { id: "user-1", is_active: true },
    openShift: null,
    counters: COUNTERS,
    ...o,
  })

  it("snapshots the terminal's counters and rounds the opening fund to centavos", () => {
    const result = buildShiftOpen({ openingFund: "1500.255" }, data(), ctx())
    if (!result.ok) throw new Error(result.code)
    expect(ShiftOpenRecordSchema.parse(result.shift)).toEqual({
      ...identity,
      user_id: "user-1",
      opening_fund: 1500.26,
      snapshot_z_counter: 7,
      snapshot_accumulated_total: 12345.67,
    })
  })

  it("treats a blank opening fund as 0, as POS-bir does", () => {
    for (const openingFund of [undefined, null, "", "  "]) {
      expect(buildShiftOpen({ openingFund }, data(), ctx())).toMatchObject({ ok: true, shift: { opening_fund: 0 } })
    }
  })

  it("allows one open shift per terminal, so another terminal's open shift doesn't block", () => {
    expect(buildShiftOpen({}, data({ openShift: shiftOpen({ terminal_id: T2 }) }), ctx()).ok).toBe(true)
    expect(buildShiftOpen({}, data({ openShift: shiftOpen() }), ctx())).toMatchObject({ ok: false, code: "SHIFT_ALREADY_OPEN" })
  })

  it("refuses an opening fund that is negative or not a number (POS-bir stores it as sent)", () => {
    for (const openingFund of [-1, "-0.01", "abc", Infinity, NaN]) {
      expect(buildShiftOpen({ openingFund }, data(), ctx())).toMatchObject({ ok: false, code: "INVALID_OPENING_FUND" })
    }
  })

  it("needs a signed-in, existing, active user, and a refusal creates nothing", () => {
    const cases: [Partial<ShiftContext>, Partial<ShiftOpenData>, string][] = [
      [{ userId: null }, {}, "USER_REQUIRED"],
      [{}, { user: null }, "USER_NOT_FOUND"],
      [{}, { user: { id: "someone-else", is_active: true } }, "USER_NOT_FOUND"],
      [{}, { user: { id: "user-1", is_active: false } }, "USER_INACTIVE"],
    ]
    for (const [c, d, code] of cases) {
      const { ctx, taken } = context(c)
      expect(buildShiftOpen({}, data(d), ctx)).toMatchObject({ ok: false, code })
      expect(taken).toEqual({ ids: 0, seqs: 0 })
    }
  })
})

describe("buildCashMovement", () => {
  const open = { openShift: shiftOpen() }

  it("records into the open shift, in centavos, with the reason trimmed", () => {
    const { ctx, taken } = context({ userId: "mgr" })
    const result = buildCashMovement({ type: "SAFE_DROP", amount: "250.005", reason: "  Evening drop " }, open, ctx)
    if (!result.ok) throw new Error(result.code)
    expect(CashMovementRecordSchema.parse(result.movement)).toEqual({
      ...identity,
      shift_id: "shift-1",
      user_id: "mgr",
      type: "SAFE_DROP",
      amount: 250.01,
      reason: "Evening drop",
    })
    expect(taken).toEqual({ ids: 1, seqs: 1 })
  })

  it("needs this terminal's open shift (POS-bir accepts any shift id, even a closed one)", () => {
    const request = { type: "CASH_IN", amount: 10, reason: "Coins" }
    expect(buildCashMovement(request, { openShift: null }, ctx())).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
    expect(buildCashMovement(request, { openShift: shiftOpen({ terminal_id: T2 }) }, ctx())).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
  })

  it("refuses amounts that are not above zero in centavos (POS-bir stores negative or text amounts)", () => {
    for (const amount of [-50, "-50", "0", "abc", 0.004, Infinity]) {
      const { ctx, taken } = context()
      expect(buildCashMovement({ type: "CASH_OUT", amount, reason: "x" }, open, ctx)).toMatchObject({ ok: false, code: "INVALID_AMOUNT" })
      expect(taken).toEqual({ ids: 0, seqs: 0 })
    }
  })

  it("treats a reason of only spaces as missing, and checks the type", () => {
    expect(buildCashMovement({ type: "CASH_IN", amount: 5, reason: "   " }, open, ctx())).toMatchObject({ ok: false, code: "MISSING_DETAILS" })
    expect(buildCashMovement({ type: null, amount: 5, reason: "x" }, open, ctx())).toMatchObject({ ok: false, code: "MISSING_DETAILS" })
    expect(buildCashMovement({ type: "cash_in", amount: 5, reason: "x" }, open, ctx())).toMatchObject({ ok: false, code: "INVALID_MOVEMENT_TYPE" })
  })
})

describe("computeShiftClose", () => {
  const data = (o: Partial<ShiftCloseData> = {}): ShiftCloseData => ({
    shift: shiftOpen(),
    closes: [],
    transactions: [],
    cashMovements: [],
    creditLedgerEntries: [],
    counters: COUNTERS,
    ...o,
  })
  const counted = { actualCash: 0, actualGcash: 0, actualMaya: 0, actualCard: 0 }

  it("records each method's variance and their total, linked to the shift, with the counters at close", () => {
    const transactions = [sale({ net_sales: 200 }), sale({ net_sales: 100, payment_method: "GCASH" })]
    const { ctx, taken } = context({ userId: "mgr" })
    const result = computeShiftClose({ actualCash: "1190.5", actualGcash: 110 }, data({ transactions }), ctx)
    if (!result.ok) throw new Error(result.code)
    expect(ShiftCloseRecordSchema.parse(result.close)).toEqual({
      ...identity,
      shift_id: "shift-1",
      user_id: "mgr",
      theoretical_cash: 1200,
      actual_cash: 1190.5,
      cash_variance: -9.5,
      theoretical_gcash: 100,
      actual_gcash: 110,
      gcash_variance: 10,
      theoretical_maya: 0,
      actual_maya: 0,
      maya_variance: 0,
      theoretical_card: 0,
      actual_card: 0,
      card_variance: 0,
      variance: 0.5,
      snapshot_z_counter: 7,
      snapshot_accumulated_total: 12345.67,
    })
    expect(taken).toEqual({ ids: 1, seqs: 1 })
  })

  it("counts only this shift's records on this terminal", () => {
    const result = computeShiftClose(
      counted,
      data({
        shift: shiftOpen({ opening_fund: 0 }),
        transactions: [
          sale({ net_sales: 100 }),
          sale({ net_sales: 1000, terminal_id: T2 }), // another terminal, even with the same shift id
          sale({ net_sales: 1000, shift_id: "shift-0" }), // an earlier shift on this terminal
        ],
        cashMovements: [
          movement({ amount: 5 }),
          movement({ amount: 1000, terminal_id: T2 }),
          movement({ amount: 1000, shift_id: "shift-0" }),
        ],
        creditLedgerEntries: [
          ledgerEntry({ amount: 7 }),
          ledgerEntry({ amount: 1000, terminal_id: T2 }),
          ledgerEntry({ amount: 1000, shift_id: "shift-0" }),
          ledgerEntry({ amount: 1000, shift_id: null }), // taken outside any shift
        ],
      }),
      ctx()
    )
    expect(result).toMatchObject({ ok: true, close: { theoretical_cash: 105, theoretical_gcash: 7 } })
  })

  it("takes a credit note issued in this shift for an earlier shift's sale off this shift's drawer", () => {
    const earlierCash = sale({ shift_id: "shift-0", net_sales: 80 })
    const earlierGcash = sale({ shift_id: "shift-0", net_sales: 252, payment_method: "GCASH", reference_number: "GC-1" })
    const transactions = [earlierCash, earlierGcash, sale({ net_sales: 300 }), creditNote(earlierCash, "shift-1"), creditNote(earlierGcash, "shift-1")]

    const result = computeShiftClose(counted, data({ transactions }), ctx())
    expect(result).toMatchObject({ ok: true, close: { theoretical_cash: 1000 + 300 - 80, theoretical_gcash: -252 } })
    // The earlier shift is unaffected: its sales count there, its drawer was already closed
    const earlier = computeShiftClose(counted, data({ shift: shiftOpen({ id: "shift-0" }), transactions }), ctx())
    expect(earlier).toMatchObject({ ok: true, close: { shift_id: "shift-0", theoretical_cash: 1000 + 80, theoretical_gcash: 252 } })
  })

  it("expects store-credit payments taken by GCash, Maya or card, and a cash one only through its CASH_IN", () => {
    const creditLedgerEntries = [
      ledgerEntry({ payment_method: "GCASH", amount: 120.5 }),
      ledgerEntry({ payment_method: "MAYA", amount: 30 }),
      ledgerEntry({ payment_method: "CARD", amount: 45.25 }),
      ledgerEntry({ payment_method: "CASH", amount: 100 }), // its CASH_IN below is what counts
      ledgerEntry({ entry_type: "CHARGE", payment_method: null, amount: 999 }),
      ledgerEntry({ entry_type: "ADJUSTMENT", payment_method: null, amount: 999 }),
    ]
    const cashMovements = [movement({ type: "CASH_IN", amount: 100, reason: "Debt Payment - Aling Rosa" })]
    const result = computeShiftClose(
      { actualCash: 1100, actualGcash: 120.5, actualMaya: 30, actualCard: 45.25 },
      data({ creditLedgerEntries, cashMovements }),
      ctx()
    )
    expect(result).toMatchObject({
      ok: true,
      close: { theoretical_cash: 1100, theoretical_gcash: 120.5, theoretical_maya: 30, theoretical_card: 45.25, variance: 0 },
      creditPayments: { gcash: 120.5, maya: 30, card: 45.25 },
    })
  })

  it("expects what buildCreditPayment records: a GCash payment in GCash, a cash one once (its CASH_IN)", () => {
    let seq = 0
    const shared = { storeId: "store-1", terminalId: T1, userId: "user-1", now: new Date(NOW), nextSeq: () => ++seq }
    const opened = buildShiftOpen({ openingFund: 500 }, { user: { id: "user-1", is_active: true }, openShift: null, counters: COUNTERS }, { ...shared, newId: () => "shift-e2e" })
    if (!opened.ok) throw new Error(opened.code)
    const customer = { id: "rosa", full_name: "Aling Rosa", current_debt_balance: 400 }
    const pay = (paymentMethod: "CASH" | "GCASH", amount: number) => {
      const result = buildCreditPayment({ customerId: "rosa", amount, paymentMethod }, { openShift: opened.shift, customer }, { ...shared, newId: () => `pay-${++seq}` })
      if (!result.ok) throw new Error(result.code)
      return result
    }
    const cash = pay("CASH", 100)
    const gcash = pay("GCASH", 150.25)
    const result = computeShiftClose(
      { actualCash: 600, actualGcash: 150.25 },
      {
        shift: opened.shift,
        transactions: [],
        cashMovements: [cash.cashMovement!],
        creditLedgerEntries: [cash.ledgerEntry, gcash.ledgerEntry],
        counters: COUNTERS,
      },
      { ...shared, newId: () => "close-e2e" }
    )
    expect(result).toMatchObject({
      ok: true,
      close: { shift_id: "shift-e2e", theoretical_cash: 600, theoretical_gcash: 150.25, variance: 0 },
      creditPayments: { gcash: 150.25, maya: 0, card: 0 },
    })
  })

  it("keeps store credit sales out of the drawer, and nets each method separately", () => {
    const credit = sale({ net_sales: 500, payment_method: "STORE_CREDIT", reference_number: "rosa" })
    const result = computeShiftClose(
      { actualCash: 1000, actualMaya: 40, actualCard: 60 },
      data({ transactions: [credit, creditNote(credit, "shift-1"), sale({ payment_method: "MAYA", net_sales: 45.5 }), sale({ payment_method: "CARD", net_sales: 60 })] }),
      ctx()
    )
    expect(result).toMatchObject({
      ok: true,
      close: { theoretical_cash: 1000, theoretical_gcash: 0, theoretical_maya: 45.5, maya_variance: -5.5, theoretical_card: 60, card_variance: 0 },
    })
  })

  it("sums in centavos, so totals carry no float noise", () => {
    const transactions = Array.from({ length: 10 }, () => sale({ net_sales: 0.1 }))
    const cashMovements = [movement({ type: "CASH_OUT", amount: 0.3 }), movement({ type: "CASH_IN", amount: 0.1 }), movement({ type: "CASH_IN", amount: 0.2 })]
    const result = computeShiftClose({ actualCash: 0.7 }, data({ shift: shiftOpen({ opening_fund: 0.3 }), transactions, cashMovements }), ctx())
    if (!result.ok) throw new Error(result.code)
    expect(result.close.theoretical_cash).toBe(1.3) // 0.3 + 1.0 + 0.3 - 0.3
    expect(result.close.cash_variance).toBe(-0.6)
    expect(result.cash).toEqual({ openingFund: 0.3, cashSales: 1, cashIn: 0.3, cashOut: 0.3, safeDrops: 0 })
  })

  it("counts GCash, Maya and card left out as 0, as the PC's closing dialog sends them", () => {
    const result = computeShiftClose({ actualCash: 1000 }, data({ transactions: [sale({ payment_method: "CARD", net_sales: 75 })] }), ctx())
    expect(result).toMatchObject({ ok: true, close: { actual_card: 0, card_variance: -75, variance: -75 } })
  })

  it("refuses a missing or invalid count, and a shift that isn't open here, creating nothing", () => {
    const refusals: [Parameters<typeof computeShiftClose>[0], Partial<ShiftCloseData>, string][] = [
      [{ actualCash: undefined }, {}, "MISSING_ACTUAL_CASH"],
      [{ actualCash: null }, {}, "MISSING_ACTUAL_CASH"],
      [{ actualCash: "" }, {}, "MISSING_ACTUAL_CASH"],
      [{ actualCash: -1 }, {}, "INVALID_ACTUAL_AMOUNT"],
      [{ actualCash: 0, actualGcash: "abc" }, {}, "INVALID_ACTUAL_AMOUNT"],
      [counted, { shift: null }, "SHIFT_NOT_FOUND"],
      [counted, { shift: shiftOpen({ terminal_id: T2 }) }, "SHIFT_NOT_FOUND"],
      [counted, { closes: [{ shift_id: "shift-1" }] }, "SHIFT_ALREADY_CLOSED"],
    ]
    for (const [request, d, code] of refusals) {
      const { ctx, taken } = context()
      expect(computeShiftClose(request, data(d), ctx)).toMatchObject({ ok: false, code })
      expect(taken).toEqual({ ids: 0, seqs: 0 })
    }
    expect(computeShiftClose(counted, data({ closes: [{ shift_id: "shift-0" }] }), ctx()).ok).toBe(true)
  })
})
