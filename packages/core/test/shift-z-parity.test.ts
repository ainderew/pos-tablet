// Golden parity: fixtures/pc-shift-z-parity.json drove POS-bir's real shift, sale, void, cash-movement
// and Z-reading routes through three business days (see fixtures/README.md). Replaying the same steps
// here, the shift and Z-reading rules must give the same snapshots, expected amounts, variances,
// Z totals, SI/CN ranges, grand totals and Z counters, and refuse the same requests.
//
// Sales and credit notes are rebuilt from POS-bir's rows (POS-bir has no shift_id, so each gets the
// shift that was open when the generator made it, which is what the tablet records). Everything else
// is built by @pos/core and chained: its own shift opens, closes and Z-readings feed the next step.
// Money is compared to the centavo: POS-bir does not round its sums (1221.8000000000002), core sums
// whole centavos.
import { describe, expect, it } from "vitest"
import {
  CashMovementRecordSchema,
  ShiftCloseRecordSchema,
  ShiftOpenRecordSchema,
  TransactionRecordSchema,
  ZReadingRecordSchema,
} from "../src/model"
import type { CashMovementRecord, ShiftCloseRecord, ShiftOpenRecord, TransactionRecord } from "../src/model"
import { roundMoney } from "../src/ph-tax"
import { buildCashMovement, buildShiftOpen, computeShiftClose, findOpenShift } from "../src/shift"
import type { ShiftErrorCode } from "../src/shift"
import { computeZReading, previewZReading, terminalCounters } from "../src/z-reading"
import type { ZReadingBoundary, ZReadingData } from "../src/z-reading"
import fixtures from "./fixtures/pc-shift-z-parity.json"

type Row = Record<string, any>
interface Step {
  kind: "open_shift" | "sale" | "void" | "cash_movement" | "close_shift" | "z_preview" | "z_reading" | "add_terminal"
  name: string
  at: string
  status?: number
  request?: Row
  response?: Row
  audit?: Row | null
  shiftId?: string | null
  transactionId?: string
  creditNoteId?: string
  terminalAfter?: Row
  terminal?: Row
  zReadingsSoFar?: number
}
interface Fixture {
  generatedFrom: string
  initial: { users: Row[]; settingsGrandTotal: string }
  steps: Step[]
  tables: { transactions: Row[]; shifts: Row[] }
}

// POS-bir reports errors as messages; map them to the codes core may return
const PC_ERRORS: [RegExp, ShiftErrorCode[]][] = [
  [/^User ID is required/, ["USER_REQUIRED"]],
  [/^A shift is already open/, ["SHIFT_ALREADY_OPEN"]],
  [/^Terminal already has an open shift/, ["SHIFT_ALREADY_OPEN"]],
  [/^User not found/, ["USER_NOT_FOUND"]],
  [/^User is not active/, ["USER_INACTIVE"]],
  [/^Missing movement details/, ["MISSING_DETAILS"]],
  [/^Invalid movement type/, ["INVALID_MOVEMENT_TYPE"]],
  [/^Missing shift details/, ["MISSING_ACTUAL_CASH"]],
  [/^Shift not found or already closed/, ["SHIFT_NOT_FOUND", "SHIFT_ALREADY_CLOSED"]],
]

const f = fixtures as unknown as Fixture
const STORE = "store-1"
const at = (pc: string) => new Date(`${pc.replace(" ", "T")}Z`) // SQLite UTC "YYYY-MM-DD HH:MM:SS"
const centavo = (pc: unknown) => roundMoney(Number(pc))

const pcTransactions = new Map(f.tables.transactions.map((r) => [r.id as string, r]))
const pcByInvoice = new Map(f.tables.transactions.map((r) => [r.invoice_number as string, r]))
const pcShifts = new Map(f.tables.shifts.map((s) => [s.id as string, s]))
const users = new Map(f.initial.users.map((u) => [u.id as string, { id: u.id as string, is_active: Boolean(u.is_active) }]))
const openingGrandTotal = Number(f.initial.settingsGrandTotal)

/** A POS-bir transactions row as the tablet records it (VOIDED is derived, so sales stay PAID) */
function toTransactionRecord(row: Row, shiftId: string): TransactionRecord {
  const isCreditNote = row.transaction_type === "VOID_REFUND"
  return {
    id: row.id,
    store_id: STORE,
    terminal_id: pcShifts.get(shiftId)!.terminal_id,
    created_at: at(row.created_at).toISOString(),
    shift_id: shiftId,
    cashier_id: null,
    invoice_number: row.invoice_number,
    transaction_type: row.transaction_type,
    status: isCreditNote ? "REFUND" : "PAID",
    original_transaction_id: isCreditNote ? pcByInvoice.get(row.reference_number)!.id : null,
    void_reason: isCreditNote ? row.void_reason : null,
    authorized_by: isCreditNote ? row.void_authorized_by : null,
    gross_sales: row.gross_sales,
    vatable_sales: row.vatable_sales,
    vat_amount: row.vat_amount,
    vat_exempt_sales: row.vat_exempt_sales,
    zero_rated_sales: row.zero_rated_sales,
    total_discount: row.total_discount,
    net_sales: row.net_sales,
    pax_count: row.pax_count,
    senior_count: row.senior_count,
    sc_pwd_id: row.sc_pwd_id,
    sc_pwd_name: row.sc_pwd_name,
    payment_method: row.payment_method,
    amount_tendered: row.amount_tendered,
    change_amount: row.change_amount,
    reference_number: row.reference_number,
  }
}

// ---- Replay -----------------------------------------------------------------------------------------

const opens: ShiftOpenRecord[] = []
const closes: ShiftCloseRecord[] = []
const transactions: TransactionRecord[] = []
const movements: CashMovementRecord[] = []
const lastZ = new Map<string, ZReadingBoundary>() // per terminal
let lastPcZ: Step | null = null
let pcPreviewCount: number | null = null

interface Outcome {
  step: Step
  result: any
  pcSalesCount?: number | null
}
const outcomes: Outcome[] = []

const ctx = (terminalId: string, userId: string | null, step: Step, id?: string) => ({
  storeId: STORE,
  terminalId,
  userId,
  now: at(step.at),
  newId: () => id ?? `core-${step.name}`, // POS-bir's id, so later steps can refer to it
})
const counters = (terminalId: string) => terminalCounters(lastZ.get(terminalId) ?? null, openingGrandTotal)
const zData = (terminalId: string): ZReadingData => ({
  transactions,
  shiftOpens: opens,
  cashMovements: movements,
  previous: lastZ.get(terminalId) ?? null,
  openingGrandTotal,
})

f.steps.forEach((step, i) => {
  const body = step.request ?? {}
  switch (step.kind) {
    case "open_shift": {
      const terminalId = body.terminalId
      const result = buildShiftOpen(
        { openingFund: body.openingFund },
        { user: users.get(body.userId) ?? null, openShift: findOpenShift(opens, closes, terminalId), counters: counters(terminalId) },
        ctx(terminalId, body.userId ?? null, step, step.response?.id)
      )
      if (result.ok) opens.push(result.shift)
      outcomes.push({ step, result })
      break
    }
    case "sale":
      transactions.push(toTransactionRecord(pcTransactions.get(step.transactionId!)!, step.shiftId!))
      break
    case "void":
      transactions.push(toTransactionRecord(pcTransactions.get(step.creditNoteId!)!, step.shiftId!))
      break
    case "cash_movement": {
      const terminalId = opens.find((s) => s.id === body.shiftId)!.terminal_id
      const result = buildCashMovement(
        { type: body.type, amount: body.amount, reason: body.reason },
        { openShift: findOpenShift(opens, closes, terminalId) },
        ctx(terminalId, null, step, step.response?.id)
      )
      if (result.ok) movements.push(result.movement)
      outcomes.push({ step, result })
      break
    }
    case "close_shift": {
      const shift = opens.find((s) => s.id === body.shiftId) ?? null
      const terminalId = shift!.terminal_id
      const result = computeShiftClose(
        { actualCash: body.actualCash, actualGcash: body.actualGcash, actualMaya: body.actualMaya, actualCard: body.actualCard },
        { shift, closes, transactions, cashMovements: movements, counters: counters(terminalId) },
        ctx(terminalId, null, step)
      )
      if (result.ok) closes.push(result.close)
      outcomes.push({ step, result })
      break
    }
    case "add_terminal":
      // A migrated terminal never Z-read: its previous Z is the PC's last Z-reading (POS-bir continues
      // from that GT, with the number of Z-readings so far as the counter)
      lastZ.set(step.terminal!.id, {
        terminal_id: step.terminal!.id,
        created_at: at(lastPcZ!.response!.reading_date).toISOString(),
        z_counter: step.zReadingsSoFar!,
        accumulated_grand_total: lastPcZ!.response!.accumulated_grand_total,
      })
      break
    case "z_preview": {
      // POS-bir's preview is for the whole database; here it is for the terminal of the next Z
      const terminalId = f.steps.slice(i).find((s) => s.kind === "z_reading")!.request!.terminalId
      const result = previewZReading(zData(terminalId), { terminalId, now: at(step.at) })
      pcPreviewCount = Number(step.response!.count)
      outcomes.push({ step, result })
      break
    }
    case "z_reading": {
      const terminalId = body.terminalId
      const result = computeZReading(zData(terminalId), ctx(terminalId, null, step, step.response!.id))
      if (result.ok) lastZ.set(terminalId, result.reading)
      outcomes.push({ step, result, pcSalesCount: pcPreviewCount })
      lastPcZ = step
      pcPreviewCount = null
      break
    }
  }
})

// ---- Checks -----------------------------------------------------------------------------------------

function expectSameError(step: Step, result: any) {
  const codes = PC_ERRORS.find(([re]) => re.test(step.response!.error))?.[1]
  expect(codes, `unmapped POS-bir error: ${step.response!.error}`).toBeDefined()
  expect(result.ok, "core accepted what POS-bir refused").toBe(false)
  expect(codes).toContain(result.code)
}

function checkOpen(pc: Row, shift: ShiftOpenRecord) {
  ShiftOpenRecordSchema.parse(shift)
  expect(shift).toMatchObject({
    id: pc.id,
    terminal_id: pc.terminal_id,
    user_id: pc.user_id,
    created_at: at(pc.start_time).toISOString(),
    opening_fund: centavo(pc.opening_fund),
    snapshot_z_counter: pc.snapshot_z_counter,
    snapshot_accumulated_total: centavo(pc.snapshot_accumulated_total),
  })
}

function checkMovement(pc: Row, movement: CashMovementRecord) {
  CashMovementRecordSchema.parse(movement)
  expect(movement).toMatchObject({
    id: pc.id,
    shift_id: pc.shift_id,
    type: pc.type,
    amount: centavo(pc.amount),
    reason: pc.reason,
    created_at: at(pc.created_at).toISOString(),
  })
}

function checkClose(pc: Row, audit: Row, close: ShiftCloseRecord) {
  ShiftCloseRecordSchema.parse(close)
  expect(close.shift_id).toBe(pc.id)
  expect(close.created_at).toBe(at(pc.end_time).toISOString())
  for (const method of ["cash", "gcash", "maya", "card"] as const) {
    expect(close[`theoretical_${method}`], `theoretical_${method}`).toBe(centavo(pc[`theoretical_${method}`]))
    expect(close[`actual_${method}`], `actual_${method}`).toBe(centavo(pc[`actual_${method}`]))
    expect(close[`${method}_variance`], `${method}_variance`).toBe(centavo(audit.variance[method]))
  }
  expect(close.variance, "total variance").toBe(centavo(pc.variance))
  expect(close.variance).toBe(centavo(audit.variance.total))
  expect(close.snapshot_z_counter).toBe(audit.closing_z_counter)
  expect(close.snapshot_accumulated_total).toBe(centavo(audit.closing_accumulated_total))
}

/** Z_TOTALS_SQL columns (GET preview) against core's figures */
function checkTotals(pc: Row, z: Row) {
  expect(z.void_count, "void_count").toBe(Number(pc.void_count))
  expect(z.sales_total, "sales_total").toBe(centavo(pc.sales_total))
  expect(z.void_total, "void_total").toBe(centavo(pc.void_total))
  expect(z.beginning_credit_note, "start_credit_note").toBe(pc.start_credit_note)
  expect(z.ending_credit_note, "end_credit_note").toBe(pc.end_credit_note)
}

function checkPreview(pc: Row, z: Row) {
  checkTotals(pc, z)
  expect(z.sales_count, "count").toBe(Number(pc.count))
  expect(z.net_total, "total_net").toBe(centavo(pc.total_net))
  expect(z.total_vat, "total_vat").toBe(centavo(pc.total_vat))
  expect(z.cash_sales_total, "total_cash_sales").toBe(centavo(pc.total_cash_sales))
  expect(z.beginning_invoice, "start_invoice").toBe(pc.start_invoice)
  expect(z.ending_invoice, "end_invoice").toBe(pc.end_invoice)
}

function checkZ(step: Step, outcome: Outcome) {
  const pc = step.response!
  const { reading, counters: after } = outcome.result
  ZReadingRecordSchema.parse(reading)
  checkTotals(pc, reading)
  expect(reading).toMatchObject({
    id: pc.id,
    terminal_id: pc.terminal_id,
    created_at: at(pc.reading_date).toISOString(),
    z_counter: pc.z_counter,
    net_total: centavo(pc.total_sales), // daily_readings.total_sales holds the net
    total_vat: centavo(pc.total_vat),
    beginning_invoice: pc.beginning_invoice,
    ending_invoice: pc.ending_invoice,
    beginning_grand_total: centavo(pc.beginning_grand_total),
    accumulated_grand_total: centavo(pc.accumulated_grand_total),
    opening_funds_total: centavo(pc.cash_breakdown.beginning_funds),
    cash_sales_total: centavo(pc.cash_breakdown.cash_sales),
    cash_in_total: centavo(pc.cash_breakdown.cash_in),
    cash_out_total: centavo(pc.cash_breakdown.cash_out),
    safe_drop_total: centavo(pc.cash_breakdown.safe_drops),
    theoretical_cash: centavo(pc.cash_breakdown.theoretical_cash),
  })
  expect(reading.net_total).toBe(roundMoney(reading.sales_total - reading.void_total))
  // POST doesn't return the sales count; the preview just before it covers the same period
  expect(outcome.pcSalesCount, "a preview precedes every Z").not.toBeNull()
  expect(reading.sales_count).toBe(outcome.pcSalesCount)
  // The terminal's counters afterwards
  expect(after).toEqual({ zCounter: step.terminalAfter!.last_z_counter, grandTotal: centavo(step.terminalAfter!.accumulated_grand_total) })
}

describe(`shifts and Z-readings match POS-bir (${f.generatedFrom})`, () => {
  it("rebuilds every POS-bir sale and credit note as a valid TransactionRecord", () => {
    expect(transactions).toHaveLength(f.tables.transactions.length)
    for (const t of transactions) TransactionRecordSchema.parse(t)
  })

  it.each(outcomes.map((o) => [`${o.step.kind}: ${o.step.name}`, o] as const))("%s", (_name, outcome) => {
    const { step, result } = outcome
    if (step.status! >= 400) return expectSameError(step, result)
    expect(result.ok, `core refused: ${result.code} ${result.message}`).toBe(true)
    switch (step.kind) {
      case "open_shift":
        return checkOpen(step.response!, result.shift)
      case "cash_movement":
        return checkMovement(step.response!, result.movement)
      case "close_shift":
        return checkClose(step.response!, step.audit!, result.close)
      case "z_preview":
        return checkPreview(step.response!, result.figures)
      case "z_reading":
        return checkZ(step, outcome)
    }
  })

  it("covers the flows the rules depend on", () => {
    const names = f.steps.map((s) => s.name)
    for (const name of [
      "void_s7_same_shift", // void in the same shift
      "void_s8_gcash_from_shift_1", // void of a previous shift's sale (reduces this shift's GCash)
      "void_s9_cash_from_shift_1",
      "void_s6_sc_sale_from_before_z1", // void of a sale from before the previous Z
      "z1", "z2", "z3", // GT accumulates, counter increments; z3 is empty
      "z4_legacy_terminal", // upgraded install continuing the PC's chain
    ]) {
      expect(names).toContain(name)
    }
    const z = outcomes.filter((o) => o.step.kind === "z_reading").map((o) => o.result.reading)
    expect(z.map((r) => r.z_counter)).toEqual([1, 2, 3, 4])
    expect(z[1].accumulated_grand_total).toBeLessThan(z[1].beginning_grand_total) // voids of z1's sales
    expect(z[2]).toMatchObject({ sales_count: 0, void_count: 0, net_total: 0, beginning_invoice: null })
  })
})
