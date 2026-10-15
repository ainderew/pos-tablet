// Z-reading rules beyond what the POS-bir fixture reaches: the period is by creation order (device_seq)
// so clock resets and out-of-order records can't drop or double-count a sale (POS-bir lost them),
// several terminals, migrated terminals, long invoice numbers, and input checks.
import { describe, expect, it } from "vitest"
import { ZReadingRecordSchema } from "../src/model"
import type { CashMovementRecord, CreditNoteRecord, SaleRecord, ShiftOpenRecord, TransactionRecord } from "../src/model"
import { computeZReading, previewZReading, terminalCounters } from "../src/z-reading"
import type { ZReadingBoundary, ZReadingContext, ZReadingData } from "../src/z-reading"

const T1 = "terminal-1"
const T2 = "terminal-2"
const PREVIOUS_AT = "2026-10-15T00:00:00.250Z"
const PREVIOUS_SEQ = 100
const NOW = new Date("2026-10-15T20:00:00.000Z")
const Z_SEQ = 1000 // the Z's own device_seq from context()
let n = PREVIOUS_SEQ // records made after the previous Z get device_seq 101, 102, ...

function context(o: Partial<ZReadingContext> = {}) {
  const taken = { ids: 0, seqs: 0 }
  const ctx: ZReadingContext = {
    storeId: "store-1",
    terminalId: T1,
    userId: "mgr",
    now: NOW,
    newId: () => `z-${++taken.ids}`,
    nextSeq: () => Z_SEQ - 1 + ++taken.seqs,
    ...o,
  }
  return { ctx, taken }
}
const ctx = (o: Partial<ZReadingContext> = {}) => context(o).ctx
const previous = (o: Partial<ZReadingBoundary> = {}): ZReadingBoundary => ({
  terminal_id: T1,
  device_seq: PREVIOUS_SEQ,
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

const base = (o: { terminal_id?: string; device_seq?: number; created_at?: string }) => ({
  id: `rec-${++n}`,
  store_id: "store-1",
  terminal_id: o.terminal_id ?? T1,
  device_seq: o.device_seq ?? n,
  created_at: o.created_at ?? "2026-10-15T10:00:00.000Z",
})
const sale = (o: Partial<SaleRecord> = {}): SaleRecord => ({
  ...base(o),
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
const creditNote = (original: SaleRecord, o: { device_seq?: number; created_at?: string } = {}): CreditNoteRecord => ({
  ...sale(o),
  invoice_number: `CN-${String(n).padStart(6, "0")}`,
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
const shiftOpen = (o: Partial<ShiftOpenRecord> = {}): ShiftOpenRecord => ({
  ...base(o),
  user_id: "user-1",
  opening_fund: 1000,
  snapshot_z_counter: 4,
  snapshot_accumulated_total: 5000,
  ...o,
})
const movement = (o: Partial<CashMovementRecord> = {}): CashMovementRecord => ({
  ...base(o),
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
const zReading = (d: ZReadingData, o: Partial<ZReadingContext> = {}) => {
  const result = computeZReading(d, ctx(o))
  if (!result.ok) throw new Error(result.code)
  return result.reading
}

describe("Z-reading period (by creation order, never the clock)", () => {
  it("covers previous.device_seq < device_seq < its own device_seq", () => {
    const transactions = [
      sale({ device_seq: PREVIOUS_SEQ - 1, invoice_number: "SI-000001" }), // before the previous Z
      sale({ device_seq: PREVIOUS_SEQ, invoice_number: "SI-000009" }), // the previous Z's own seq: never another record's
      sale({ device_seq: PREVIOUS_SEQ + 1, invoice_number: "SI-000002" }),
      sale({ device_seq: Z_SEQ - 1, invoice_number: "SI-000003" }),
      sale({ device_seq: Z_SEQ + 1, invoice_number: "SI-000004" }), // created after this Z
    ]
    const reading = zReading(data({ transactions }))
    expect(reading).toMatchObject({ device_seq: Z_SEQ, beginning_invoice: "SI-000002", ending_invoice: "SI-000003", sales_count: 2 })
    // The preview has no device_seq of its own: everything after the previous Z
    expect(figures(data({ transactions })).sales_count).toBe(3)
  })

  it("counts a sale stamped before the previous Z (the clock was set back) exactly once", () => {
    // Z1 at 20:00; the clock then resets to 18:00 and a sale is stamped 18:30, after Z1 by creation order
    const z1 = zReading(data(), { now: new Date("2026-10-15T20:00:00.000Z") })
    const stampedEarlier = sale({ device_seq: Z_SEQ + 1, created_at: "2026-10-15T18:30:00.000Z", net_sales: 50 })
    const later = data({ transactions: [stampedEarlier], previous: z1 })
    // While the clock is still behind, the Z is refused (its printed date would go back); nothing is lost
    const refused = computeZReading(later, context({ now: new Date("2026-10-15T19:00:00.000Z"), nextSeq: () => Z_SEQ + 2 }).ctx)
    expect(refused).toMatchObject({ ok: false, code: "CLOCK_BEHIND" })
    // Once the clock is fixed, the next Z counts it
    const z2 = zReading(later, { now: new Date("2026-10-16T20:00:00.000Z"), nextSeq: () => Z_SEQ + 2 })
    expect(z2).toMatchObject({ sales_count: 1, net_total: 50, beginning_grand_total: 5000, accumulated_grand_total: 5050, z_counter: 6 })
    // ...and only that Z: the one after it starts past it
    const z3 = zReading({ ...later, previous: z2 }, { now: new Date("2026-10-17T20:00:00.000Z"), nextSeq: () => Z_SEQ + 3 })
    expect(z3).toMatchObject({ sales_count: 0, accumulated_grand_total: 5050 })
  })

  it("counts a record stamped after now when it was created before the Z", () => {
    const future = sale({ created_at: "2026-10-15T23:00:00.000Z" })
    expect(zReading(data({ transactions: [future] })).sales_count).toBe(1)
  })

  it("gives the same reading whatever order the records arrive in, and whatever their timestamps", () => {
    const transactions: TransactionRecord[] = []
    for (let i = 0; i < 20; i++) {
      const s = sale({ created_at: new Date(Date.parse("2026-10-15T10:00:00.000Z") - i * 600_000).toISOString(), net_sales: i + 0.25 })
      transactions.push(s)
      if (i % 4 === 0) transactions.push(creditNote(s))
    }
    // Newest first, then every third record moved to the end (as a sync pull might deliver them)
    const reversed = [...transactions].reverse()
    const shuffled = [...reversed.filter((_, i) => i % 3 !== 0), ...reversed.filter((_, i) => i % 3 === 0)]
    expect(shuffled.map((t) => t.device_seq)).not.toEqual(transactions.map((t) => t.device_seq))
    expect(figures(data({ transactions: shuffled }))).toEqual(figures(data({ transactions })))
    expect(figures(data({ transactions: shuffled }))).toMatchObject({ sales_count: 20, void_count: 5 })
  })

  it("counts every record in exactly one Z across a chain of readings, with the clock jumping around", () => {
    let seed = 42 // Park-Miller, so the run is the same every time
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const start = Date.parse("2026-10-15T00:00:00.000Z")
    const stamp = () => new Date(start + Math.floor(random() * 3 * 86_400_000)).toISOString() // any time over 3 days
    // One terminal's history in creation order: sales, some voided, and Z-readings in between
    const transactions: TransactionRecord[] = []
    const zSeqs: number[] = []
    for (let seq = 1, i = 0; i < 260; i++, seq++) {
      if (i % 40 === 39) {
        zSeqs.push(seq)
        continue
      }
      const s = sale({ device_seq: seq, created_at: stamp(), net_sales: Math.round(random() * 100_000) / 100, invoice_number: `SI-${String(i + 1).padStart(6, "0")}` })
      transactions.push(s)
      if (random() < 0.2) transactions.push(creditNote(s, { device_seq: ++seq, created_at: stamp() }))
    }
    zSeqs.push(10_000)

    let prev: ZReadingBoundary | null = null
    let counted = 0
    let netCents = 0
    for (const [k, zSeq] of zSeqs.entries()) {
      // Every record, even ones created after this Z, is passed in: the Z picks its own
      const reading = zReading(data({ transactions, previous: prev, openingGrandTotal: 100 }), {
        now: new Date(start + 86_400_000 * 4 + k * 1000),
        nextSeq: () => zSeq,
      })
      counted += reading.sales_count + reading.void_count
      netCents += Math.round(reading.net_total * 100)
      prev = reading
    }
    const expectedCents = transactions.reduce((sum, t) => sum + Math.round(t.net_sales * 100), 0)
    expect(counted).toBe(transactions.length)
    expect(netCents).toBe(expectedCents)
    expect(prev!.accumulated_grand_total).toBe((10_000 + expectedCents) / 100)
    expect(prev!.z_counter).toBe(zSeqs.length)
  })

  it("covers every record passed in after a migrated terminal's PC Z-reading, which has no device_seq", () => {
    const pcZ = previous({ device_seq: undefined, z_counter: 3, accumulated_grand_total: 2478.39 })
    const transactions = [sale({ device_seq: 1, net_sales: 10 }), sale({ device_seq: 2, net_sales: 20 })]
    expect(zReading(data({ transactions, previous: pcZ }))).toMatchObject({ sales_count: 2, z_counter: 4, beginning_grand_total: 2478.39, accumulated_grand_total: 2508.39 })
    expect(figures(data({ transactions, previous: { ...pcZ, device_seq: null } })).sales_count).toBe(2)
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
    const inEarlierZ = sale({ device_seq: PREVIOUS_SEQ - 5, net_sales: 300, vat_amount: 32.14, payment_method: "GCASH" })
    const a = sale({ net_sales: 112, vat_amount: 12 })
    const b = sale({ net_sales: 56, vat_amount: 6, payment_method: "MAYA" })
    const voidA = creditNote(a)
    const voidEarlier = creditNote(inEarlierZ)
    const f = figures(data({ transactions: [inEarlierZ, a, b, voidA, voidEarlier] }))
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
      beginning_credit_note: voidA.invoice_number,
      ending_credit_note: voidEarlier.invoice_number,
      beginning_grand_total: 5000,
      accumulated_grand_total: 4756, // the grand total goes down: the earlier Z's sale is voided here
    })
  })

  it("orders SI and CN ranges by number, so SI-1000000 follows SI-999999", () => {
    const transactions = [sale({ invoice_number: "SI-1000000" }), sale({ invoice_number: "SI-999999" }), sale({ invoice_number: "SI-1000001" })]
    expect(figures(data({ transactions }))).toMatchObject({ beginning_invoice: "SI-999999", ending_invoice: "SI-1000001" })
  })

  it("sums in centavos, so totals carry no float noise", () => {
    const f = figures(data({ transactions: [0.1, 0.2, 0.3].map((net_sales) => sale({ net_sales, vat_amount: 0.01 })) }))
    expect(f).toMatchObject({ sales_total: 0.6, net_total: 0.6, total_vat: 0.03, accumulated_grand_total: 5000.6 })
  })

  it("breaks down cash for shifts opened and cash moved in the period only", () => {
    const f = figures(
      data({
        transactions: [sale({ net_sales: 200 }), sale({ net_sales: 99, payment_method: "CARD" })],
        shiftOpens: [shiftOpen({ opening_fund: 300, device_seq: PREVIOUS_SEQ - 10 }), shiftOpen({ opening_fund: 1000 }), shiftOpen({ opening_fund: 500.5 })],
        cashMovements: [
          movement({ type: "CASH_IN", amount: 50 }),
          movement({ type: "CASH_OUT", amount: 20.25 }),
          movement({ type: "SAFE_DROP", amount: 700 }),
          movement({ type: "SAFE_DROP", amount: 999, device_seq: PREVIOUS_SEQ - 3 }),
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
    const result = computeZReading(data({ transactions: [sale({ net_sales: 250 })], previous: null, openingGrandTotal: 1000.5 }), ctx())
    if (!result.ok) throw new Error(result.code)
    expect(result.reading).toMatchObject({ z_counter: 1, beginning_grand_total: 1000.5, accumulated_grand_total: 1250.5 })
    expect(result.counters).toEqual({ zCounter: 1, grandTotal: 1250.5 })
    // With a previous Z the opening grand total no longer matters
    const later = figures(data({ previous: result.reading, openingGrandTotal: 99999 }), new Date("2026-10-16T00:00:00.000Z"))
    expect(later).toMatchObject({ z_counter: 2, beginning_grand_total: 1250.5, accumulated_grand_total: 1250.5 })
  })

  it("records an empty Z with its identity, null ranges, zero totals and the grand total unchanged", () => {
    const { ctx, taken } = context()
    const result = computeZReading(data(), ctx)
    if (!result.ok) throw new Error(result.code)
    const z = ZReadingRecordSchema.parse(result.reading)
    expect(z).toEqual({
      id: "z-1",
      store_id: "store-1",
      terminal_id: T1,
      device_seq: Z_SEQ,
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
    expect(taken).toEqual({ ids: 1, seqs: 1 })
    for (const value of [z.void_total, z.net_total, z.theoretical_cash]) expect(Object.is(value, 0)).toBe(true) // not -0
  })

  it("records the preview's figures", () => {
    const d = data({ transactions: [sale(), creditNote(sale())], shiftOpens: [shiftOpen()], cashMovements: [movement()] })
    expect(zReading(d)).toMatchObject(figures(d))
  })

  it("refuses a date earlier than the previous Z, a previous Z of another terminal, and a bad opening GT, creating nothing", () => {
    const refusals: [Partial<ZReadingData>, Partial<ZReadingContext>, string][] = [
      [{}, { now: new Date("2026-10-15T00:00:00.249Z") }, "CLOCK_BEHIND"],
      [{ previous: previous({ terminal_id: T2 }) }, {}, "TERMINAL_MISMATCH"],
      [{ previous: null, openingGrandTotal: NaN }, {}, "INVALID_OPENING_GRAND_TOTAL"],
    ]
    for (const [d, c, code] of refusals) {
      const { ctx, taken } = context(c)
      expect(computeZReading(data(d), ctx)).toMatchObject({ ok: false, code })
      expect(previewZReading(data(d), ctx)).toMatchObject({ ok: false, code })
      expect(taken).toEqual({ ids: 0, seqs: 0 })
    }
    expect(computeZReading(data(), ctx({ now: new Date(PREVIOUS_AT) })).ok).toBe(true) // same instant is fine
  })
})

describe("terminalCounters", () => {
  it("is the previous Z's counter and grand total, or 0 and the opening grand total", () => {
    expect(terminalCounters(null, 0)).toEqual({ zCounter: 0, grandTotal: 0 })
    expect(terminalCounters(null, 1000.505)).toEqual({ zCounter: 0, grandTotal: 1000.51 })
    expect(terminalCounters(previous(), 1)).toEqual({ zCounter: 4, grandTotal: 5000 })
  })
})
