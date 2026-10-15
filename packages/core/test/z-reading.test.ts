// Z-reading rules beyond what the POS-bir fixture reaches: millisecond period boundaries (POS-bir had a
// one-second gap), several terminals, long invoice numbers, the clock going back, and input checks.
import { describe, expect, it } from "vitest"
import { ZReadingRecordSchema } from "../src/model"
import type { CashMovementRecord, ShiftOpenRecord, TransactionRecord } from "../src/model"
import { computeZReading, previewZReading, terminalCounters } from "../src/z-reading"
import type { ZReadingBoundary, ZReadingContext, ZReadingData } from "../src/z-reading"

const T1 = "terminal-1"
const T2 = "terminal-2"
const PREVIOUS_AT = "2026-10-15T00:00:00.250Z"
const NOW = new Date("2026-10-15T20:00:00.000Z")
let n = 0

const ctx = (o: Partial<ZReadingContext> = {}): ZReadingContext => ({
  storeId: "store-1",
  terminalId: T1,
  userId: "mgr",
  now: NOW,
  newId: () => `z-${++n}`,
  ...o,
})
const previous = (o: Partial<ZReadingBoundary> = {}): ZReadingBoundary => ({
  terminal_id: T1,
  created_at: PREVIOUS_AT,
  z_counter: 4,
  accumulated_grand_total: 5000,
  ...o,
})
const data = (o: Partial<ZReadingData> = {}): ZReadingData => ({
  transactions: [],
  shiftOpens: [],
  cashMovements: [],
  previous: previous(),
  openingGrandTotal: 0,
  ...o,
})

const sale = (o: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: `tx-${++n}`,
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T10:00:00.000Z",
  shift_id: "shift-1",
  cashier_id: null,
  invoice_number: `SI-${String(n).padStart(6, "0")}`,
  transaction_type: "SALE",
  status: "PAID",
  original_transaction_id: null,
  void_reason: null,
  authorized_by: null,
  gross_sales: 112,
  vatable_sales: 100,
  vat_amount: 12,
  vat_exempt_sales: 0,
  zero_rated_sales: 0,
  total_discount: 0,
  net_sales: 112,
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
const creditNote = (original: TransactionRecord, o: Partial<TransactionRecord> = {}): TransactionRecord =>
  sale({
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
    ...o,
  })
const shiftOpen = (o: Partial<ShiftOpenRecord> = {}): ShiftOpenRecord => ({
  id: `shift-${++n}`,
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T08:00:00.000Z",
  user_id: "user-1",
  opening_fund: 1000,
  snapshot_z_counter: 4,
  snapshot_accumulated_total: 5000,
  ...o,
})
const movement = (o: Partial<CashMovementRecord> = {}): CashMovementRecord => ({
  id: `cm-${++n}`,
  store_id: "store-1",
  terminal_id: T1,
  created_at: "2026-10-15T12:00:00.000Z",
  shift_id: "shift-1",
  user_id: null,
  type: "CASH_IN",
  amount: 100,
  reason: "x",
  ...o,
})

const figures = (d: ZReadingData, now = NOW) => {
  const result = previewZReading(d, { terminalId: T1, now })
  if (!result.ok) throw new Error(result.code)
  return result.figures
}
const invoicesIn = (d: ZReadingData, now = NOW) => {
  const f = figures(d, now)
  return [f.beginning_invoice, f.ending_invoice, f.sales_count]
}

describe("Z-reading period boundaries (to the millisecond)", () => {
  it("covers previous.created_at < created_at <= now", () => {
    const atPrevious = sale({ created_at: PREVIOUS_AT, invoice_number: "SI-000001" }) // in the previous Z
    const justAfter = sale({ created_at: "2026-10-15T00:00:00.251Z", invoice_number: "SI-000002" })
    const atNow = sale({ created_at: NOW.toISOString(), invoice_number: "SI-000003" })
    const afterNow = sale({ created_at: "2026-10-15T20:00:00.001Z", invoice_number: "SI-000004" })
    expect(invoicesIn(data({ transactions: [atPrevious, justAfter, atNow, afterNow] }))).toEqual(["SI-000002", "SI-000003", 2])
  })

  it("counts a sale made in the same second as the previous Z, after it (POS-bir missed it in both Zs)", () => {
    const sameSecond = sale({ created_at: "2026-10-15T00:00:00.750Z" })
    expect(figures(data({ transactions: [sameSecond] })).sales_count).toBe(1)
  })

  it("defers a record stamped after now (the clock went back) to the Z that covers it, never twice", () => {
    const future = sale({ created_at: "2026-10-15T21:00:00.000Z", net_sales: 50 })
    const first = computeZReading(data({ transactions: [future] }), ctx())
    if (!first.ok) throw new Error(first.code)
    expect(first.reading.sales_count).toBe(0)
    const second = computeZReading(data({ transactions: [future], previous: first.reading }), ctx({ now: new Date("2026-10-15T22:00:00.000Z") }))
    expect(second).toMatchObject({ ok: true, reading: { sales_count: 1, net_total: 50, accumulated_grand_total: 5050, z_counter: 6 } })
  })

  it("counts every record in exactly one Z across a chain of readings", () => {
    let seed = 42 // Park-Miller, so the run is the same every time
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const start = Date.parse("2026-10-15T00:00:00.000Z")
    const sales = Array.from({ length: 200 }, (_, i) =>
      sale({ created_at: new Date(start + Math.floor(random() * 86_400_000)).toISOString(), net_sales: Math.round(random() * 100_000) / 100, invoice_number: `SI-${String(i + 1).padStart(6, "0")}` })
    )
    const transactions = [...sales, ...sales.filter(() => random() < 0.2).map((s) => creditNote(s, { created_at: new Date(Date.parse(s.created_at) + 1).toISOString() }))]
    // Z-readings at random times, some landing exactly on a record's timestamp
    const zTimes = [...Array.from({ length: 6 }, () => start + Math.floor(random() * 86_400_000)), Date.parse(sales[7].created_at), start + 86_400_000]
      .sort((a, b) => a - b)

    let prev: ZReadingBoundary | null = null
    let counted = 0
    let netCents = 0
    for (const t of zTimes) {
      const result = computeZReading(data({ transactions, previous: prev, openingGrandTotal: 100 }), ctx({ now: new Date(t) }))
      if (!result.ok) throw new Error(result.code)
      counted += result.reading.sales_count + result.reading.void_count
      netCents += Math.round(result.reading.net_total * 100)
      prev = result.reading
    }
    const expectedCents = transactions.reduce((sum, t) => sum + Math.round(t.net_sales * 100), 0)
    expect(counted).toBe(transactions.length)
    expect(netCents).toBe(expectedCents)
    expect(prev!.accumulated_grand_total).toBe((10_000 + expectedCents) / 100)
    expect(prev!.z_counter).toBe(zTimes.length)
  })
})

describe("computeZReading", () => {
  it("ignores other terminals' sales, shift opens and cash movements", () => {
    const f = figures(
      data({
        transactions: [sale({ net_sales: 10 }), sale({ net_sales: 999, terminal_id: T2 })],
        shiftOpens: [shiftOpen({ opening_fund: 500 }), shiftOpen({ opening_fund: 999, terminal_id: T2 })],
        cashMovements: [movement({ amount: 20 }), movement({ amount: 999, terminal_id: T2 })],
      })
    )
    expect(f).toMatchObject({ sales_count: 1, net_total: 10, opening_funds_total: 500, cash_in_total: 20, theoretical_cash: 530 })
  })

  it("counts sales voided later, nets credit notes, and splits SI and CN ranges", () => {
    const inEarlierZ = sale({ created_at: "2026-10-14T10:00:00.000Z", net_sales: 300, vat_amount: 32.14, payment_method: "GCASH" })
    const a = sale({ net_sales: 112, vat_amount: 12 })
    const b = sale({ net_sales: 56, vat_amount: 6, payment_method: "MAYA" })
    const transactions = [inEarlierZ, a, b, creditNote(a), creditNote(inEarlierZ)]
    const f = figures(data({ transactions }))
    expect(f).toMatchObject({
      sales_count: 2,
      void_count: 2,
      sales_total: 168,
      void_total: 412,
      net_total: -244,
      total_vat: -26.14,
      cash_sales_total: 0, // a and its credit note
      beginning_invoice: a.invoice_number,
      ending_invoice: b.invoice_number,
      beginning_credit_note: transactions[3].invoice_number,
      ending_credit_note: transactions[4].invoice_number,
      beginning_grand_total: 5000,
      accumulated_grand_total: 4756, // the grand total goes down: the earlier Z's sale is voided here
    })
  })

  it("orders SI and CN ranges by number, so SI-1000000 follows SI-999999", () => {
    const transactions = [sale({ invoice_number: "SI-1000000" }), sale({ invoice_number: "SI-999999" }), sale({ invoice_number: "SI-1000001" })]
    expect(invoicesIn(data({ transactions }))).toEqual(["SI-999999", "SI-1000001", 3])
  })

  it("sums in centavos, so totals carry no float noise", () => {
    const f = figures(data({ transactions: [0.1, 0.2, 0.3].map((net_sales) => sale({ net_sales, vat_amount: 0.01 })) }))
    expect(f).toMatchObject({ sales_total: 0.6, net_total: 0.6, total_vat: 0.03, accumulated_grand_total: 5000.6 })
  })

  it("breaks down cash for shifts opened and cash moved in the period only", () => {
    const f = figures(
      data({
        transactions: [sale({ net_sales: 200 }), sale({ net_sales: 99, payment_method: "CARD" })],
        shiftOpens: [shiftOpen({ opening_fund: 300, created_at: "2026-10-14T08:00:00.000Z" }), shiftOpen({ opening_fund: 1000 }), shiftOpen({ opening_fund: 500.5 })],
        cashMovements: [
          movement({ type: "CASH_IN", amount: 50 }),
          movement({ type: "CASH_OUT", amount: 20.25 }),
          movement({ type: "SAFE_DROP", amount: 700 }),
          movement({ type: "SAFE_DROP", amount: 999, created_at: "2026-10-14T12:00:00.000Z" }),
        ],
      })
    )
    expect(f).toMatchObject({
      opening_funds_total: 1500.5,
      cash_sales_total: 200,
      cash_in_total: 50,
      cash_out_total: 20.25,
      safe_drop_total: 700,
      theoretical_cash: 1500.5 + 200 + 50 - 20.25 - 700,
    })
  })

  it("starts a terminal's first Z from the opening grand total at counter 1, then follows the previous Z", () => {
    const transactions = [sale({ net_sales: 250 })]
    const first = computeZReading(data({ transactions, previous: null, openingGrandTotal: 1000.5 }), ctx())
    if (!first.ok) throw new Error(first.code)
    expect(first.reading).toMatchObject({ z_counter: 1, beginning_grand_total: 1000.5, accumulated_grand_total: 1250.5 })
    expect(first.counters).toEqual({ zCounter: 1, grandTotal: 1250.5 })
    // With a previous Z the opening grand total no longer matters
    const later = figures(data({ transactions: [], previous: first.reading, openingGrandTotal: 99999 }), new Date("2026-10-16T00:00:00.000Z"))
    expect(later).toMatchObject({ z_counter: 2, beginning_grand_total: 1250.5, accumulated_grand_total: 1250.5 })
  })

  it("records an empty Z with null ranges, zero totals and the grand total unchanged", () => {
    const result = computeZReading(data(), ctx())
    if (!result.ok) throw new Error(result.code)
    const z = ZReadingRecordSchema.parse(result.reading)
    expect(z).toEqual({
      id: expect.any(String),
      store_id: "store-1",
      terminal_id: T1,
      created_at: NOW.toISOString(),
      user_id: "mgr",
      z_counter: 5,
      sales_count: 0,
      void_count: 0,
      sales_total: 0,
      void_total: 0,
      net_total: 0,
      total_vat: 0,
      cash_sales_total: 0,
      opening_funds_total: 0,
      cash_in_total: 0,
      cash_out_total: 0,
      safe_drop_total: 0,
      theoretical_cash: 0,
      beginning_invoice: null,
      ending_invoice: null,
      beginning_credit_note: null,
      ending_credit_note: null,
      beginning_grand_total: 5000,
      accumulated_grand_total: 5000,
    })
    for (const value of [z.void_total, z.net_total, z.theoretical_cash]) expect(Object.is(value, 0)).toBe(true) // not -0
  })

  it("records the preview's figures", () => {
    const d = data({ transactions: [sale(), creditNote(sale())], shiftOpens: [shiftOpen()], cashMovements: [movement()] })
    const result = computeZReading(d, ctx())
    if (!result.ok) throw new Error(result.code)
    expect(result.reading).toMatchObject(figures(d))
  })

  it("refuses a clock earlier than the previous Z, a previous Z of another terminal, and a bad opening GT", () => {
    expect(computeZReading(data(), ctx({ now: new Date("2026-10-15T00:00:00.249Z") }))).toMatchObject({ ok: false, code: "CLOCK_BEHIND" })
    expect(computeZReading(data(), ctx({ now: new Date(PREVIOUS_AT) })).ok).toBe(true) // same instant: an empty Z
    expect(computeZReading(data({ previous: previous({ terminal_id: T2 }) }), ctx())).toMatchObject({ ok: false, code: "TERMINAL_MISMATCH" })
    expect(computeZReading(data({ previous: null, openingGrandTotal: NaN }), ctx())).toMatchObject({ ok: false, code: "INVALID_OPENING_GRAND_TOTAL" })
    expect(previewZReading(data({ previous: previous({ terminal_id: T2 }) }), { terminalId: T1, now: NOW })).toMatchObject({ ok: false, code: "TERMINAL_MISMATCH" })
  })
})

describe("terminalCounters", () => {
  it("is the previous Z's counter and grand total, or 0 and the opening grand total", () => {
    expect(terminalCounters(null, 0)).toEqual({ zCounter: 0, grandTotal: 0 })
    expect(terminalCounters(null, 1000.505)).toEqual({ zCounter: 0, grandTotal: 1000.51 })
    expect(terminalCounters(previous(), 1)).toEqual({ zCounter: 4, grandTotal: 5000 })
  })
})
