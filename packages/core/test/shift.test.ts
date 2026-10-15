// Shift rules beyond what the POS-bir fixture reaches: several terminals, shift linkage of credit
// notes, centavo sums, and the input checks core adds.
import { describe, expect, it } from "vitest"
import { CashMovementRecordSchema, ShiftCloseRecordSchema, ShiftOpenRecordSchema } from "../src/model"
import type { CashMovementRecord, ShiftOpenRecord, TransactionRecord } from "../src/model"
import { buildCashMovement, buildShiftOpen, computeShiftClose, findOpenShift } from "../src/shift"
import type { ShiftCloseData, ShiftContext, ShiftOpenData } from "../src/shift"

const T1 = "terminal-1"
const T2 = "terminal-2"
const COUNTERS = { zCounter: 7, grandTotal: 12345.67 }
let n = 0
const ctx = (o: Partial<ShiftContext> = {}): ShiftContext => ({
  storeId: "store-1",
  terminalId: T1,
  userId: "user-1",
  now: new Date("2026-10-15T08:00:00.000Z"),
  newId: () => `id-${++n}`,
  ...o,
})

const shiftOpen = (o: Partial<ShiftOpenRecord> = {}): ShiftOpenRecord => ({
  id: "shift-1",
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T00:00:00.000Z",
  user_id: "user-1",
  opening_fund: 1000,
  snapshot_z_counter: 7,
  snapshot_accumulated_total: 12345.67,
  ...o,
})

const sale = (o: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: `tx-${++n}`,
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T01:00:00.000Z",
  shift_id: "shift-1",
  cashier_id: null,
  invoice_number: `SI-${String(n).padStart(6, "0")}`,
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
const creditNote = (original: TransactionRecord, shiftId: string): TransactionRecord =>
  sale({
    shift_id: shiftId,
    invoice_number: `CN-${String(++n).padStart(6, "0")}`,
    transaction_type: "VOID_REFUND",
    status: "REFUND",
    original_transaction_id: original.id,
    gross_sales: -original.gross_sales,
    vatable_sales: -original.vatable_sales,
    vat_amount: -original.vat_amount,
    net_sales: -original.net_sales,
    payment_method: original.payment_method,
    reference_number: original.invoice_number,
  })

const movement = (o: Partial<CashMovementRecord> = {}): CashMovementRecord => ({
  id: `cm-${++n}`,
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T02:00:00.000Z",
  shift_id: "shift-1",
  user_id: null,
  type: "CASH_IN",
  amount: 100,
  reason: "Change fund",
  ...o,
})

describe("findOpenShift", () => {
  it("returns this terminal's latest shift without a close record", () => {
    const opens = [
      shiftOpen({ id: "a", created_at: "2026-10-14T00:00:00.000Z" }),
      shiftOpen({ id: "b", created_at: "2026-10-15T00:00:00.000Z" }),
      shiftOpen({ id: "c", created_at: "2026-10-15T06:00:00.000Z" }),
      shiftOpen({ id: "other", terminal_id: T2, created_at: "2026-10-15T07:00:00.000Z" }),
    ]
    expect(findOpenShift(opens, [{ shift_id: "c" }], T1)?.id).toBe("b")
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
      id: expect.any(String),
      store_id: "store-1",
      terminal_id: T1,
      created_at: "2026-10-15T08:00:00.000Z",
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

  it("needs a signed-in, existing, active user", () => {
    expect(buildShiftOpen({}, data(), ctx({ userId: null }))).toMatchObject({ ok: false, code: "USER_REQUIRED" })
    expect(buildShiftOpen({}, data({ user: null }), ctx())).toMatchObject({ ok: false, code: "USER_NOT_FOUND" })
    expect(buildShiftOpen({}, data({ user: { id: "someone-else", is_active: true } }), ctx())).toMatchObject({ ok: false, code: "USER_NOT_FOUND" })
    expect(buildShiftOpen({}, data({ user: { id: "user-1", is_active: false } }), ctx())).toMatchObject({ ok: false, code: "USER_INACTIVE" })
  })
})

describe("buildCashMovement", () => {
  const open = { openShift: shiftOpen() }

  it("records into the open shift, in centavos, with the reason trimmed", () => {
    const result = buildCashMovement({ type: "SAFE_DROP", amount: "250.005", reason: "  Evening drop " }, open, ctx({ userId: "mgr" }))
    if (!result.ok) throw new Error(result.code)
    expect(CashMovementRecordSchema.parse(result.movement)).toMatchObject({
      terminal_id: T1,
      shift_id: "shift-1",
      user_id: "mgr",
      type: "SAFE_DROP",
      amount: 250.01,
      reason: "Evening drop",
      created_at: "2026-10-15T08:00:00.000Z",
    })
  })

  it("needs this terminal's open shift (POS-bir accepts any shift id, even a closed one)", () => {
    const request = { type: "CASH_IN", amount: 10, reason: "Coins" }
    expect(buildCashMovement(request, { openShift: null }, ctx())).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
    expect(buildCashMovement(request, { openShift: shiftOpen({ terminal_id: T2 }) }, ctx())).toMatchObject({ ok: false, code: "NO_OPEN_SHIFT" })
  })

  it("refuses amounts that are not above zero in centavos (POS-bir stores negative or text amounts)", () => {
    for (const amount of [-50, "-50", "0", "abc", 0.004, Infinity]) {
      expect(buildCashMovement({ type: "CASH_OUT", amount, reason: "x" }, open, ctx())).toMatchObject({ ok: false, code: "INVALID_AMOUNT" })
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
    counters: COUNTERS,
    ...o,
  })
  const counted = { actualCash: 0, actualGcash: 0, actualMaya: 0, actualCard: 0 }

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
      }),
      ctx()
    )
    expect(result).toMatchObject({ ok: true, close: { theoretical_cash: 105 } })
  })

  it("takes a credit note issued in this shift for an earlier shift's sale off this shift's drawer", () => {
    const earlierCash = sale({ shift_id: "shift-0", net_sales: 80 })
    const earlierGcash = sale({ shift_id: "shift-0", net_sales: 252, payment_method: "GCASH", reference_number: "GC-1" })
    const transactions = [earlierCash, earlierGcash, sale({ net_sales: 300 }), creditNote(earlierCash, "shift-1"), creditNote(earlierGcash, "shift-1")]

    const result = computeShiftClose(counted, data({ transactions }), ctx())
    expect(result).toMatchObject({ ok: true, close: { theoretical_cash: 1000 + 300 - 80, theoretical_gcash: -252 } })
    // The earlier shift is unaffected: its sales count there, its drawer was already closed
    const earlier = computeShiftClose(counted, data({ shift: shiftOpen({ id: "shift-0" }), transactions }), ctx())
    expect(earlier).toMatchObject({ ok: true, close: { theoretical_cash: 1000 + 80, theoretical_gcash: 252 } })
  })

  it("keeps store credit out of the drawer, and nets each method separately", () => {
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

  it("records each method's variance and their total, with the counters at close", () => {
    const transactions = [sale({ net_sales: 200 }), sale({ net_sales: 100, payment_method: "GCASH" })]
    const result = computeShiftClose({ actualCash: "1190.5", actualGcash: 110 }, data({ transactions }), ctx({ userId: "mgr" }))
    if (!result.ok) throw new Error(result.code)
    expect(ShiftCloseRecordSchema.parse(result.close)).toMatchObject({
      shift_id: "shift-1",
      user_id: "mgr",
      created_at: "2026-10-15T08:00:00.000Z",
      theoretical_cash: 1200,
      actual_cash: 1190.5,
      cash_variance: -9.5,
      gcash_variance: 10,
      maya_variance: 0,
      card_variance: 0,
      variance: 0.5,
      snapshot_z_counter: 7,
      snapshot_accumulated_total: 12345.67,
    })
  })

  it("counts GCash, Maya and card left out as 0, as the PC's closing dialog sends them", () => {
    const result = computeShiftClose({ actualCash: 1000 }, data({ transactions: [sale({ payment_method: "CARD", net_sales: 75 })] }), ctx())
    expect(result).toMatchObject({ ok: true, close: { actual_card: 0, card_variance: -75, variance: -75 } })
  })

  it("refuses a missing or invalid count, and a shift that isn't open here", () => {
    for (const actualCash of [undefined, null, ""]) {
      expect(computeShiftClose({ actualCash }, data(), ctx())).toMatchObject({ ok: false, code: "MISSING_ACTUAL_CASH" })
    }
    expect(computeShiftClose({ actualCash: -1 }, data(), ctx())).toMatchObject({ ok: false, code: "INVALID_ACTUAL_AMOUNT" })
    expect(computeShiftClose({ actualCash: 0, actualGcash: "abc" }, data(), ctx())).toMatchObject({ ok: false, code: "INVALID_ACTUAL_AMOUNT" })
    expect(computeShiftClose(counted, data({ shift: null }), ctx())).toMatchObject({ ok: false, code: "SHIFT_NOT_FOUND" })
    expect(computeShiftClose(counted, data({ shift: shiftOpen({ terminal_id: T2 }) }), ctx())).toMatchObject({ ok: false, code: "SHIFT_NOT_FOUND" })
    expect(computeShiftClose(counted, data({ closes: [{ shift_id: "shift-1" }] }), ctx())).toMatchObject({ ok: false, code: "SHIFT_ALREADY_CLOSED" })
    expect(computeShiftClose(counted, data({ closes: [{ shift_id: "shift-0" }] }), ctx()).ok).toBe(true)
  })
})
