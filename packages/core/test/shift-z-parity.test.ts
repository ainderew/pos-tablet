// Golden parity: fixtures/pc-shift-z-parity.json drove POS-bir's real shift, sale, void, debt-payment,
// cash-movement and Z-reading routes through three business days (see fixtures/README.md). Replaying
// the same steps here, the shift and Z-reading rules must give the same snapshots, expected amounts,
// variances, Z totals, SI/CN ranges, grand totals and Z counters, and refuse the same requests.
//
// Sales, credit notes, ledger entries and debt-payment CASH_INs are rebuilt from POS-bir's rows (POS-bir
// has no shift_id or device_seq, so each gets the shift that was open when the generator made it and
// the next device_seq, which is what the tablet records). Everything else is built by @pos/core and
// chained: its own shift opens, closes and Z-readings feed the next step. Money is compared to the
// centavo: POS-bir does not round its sums (1221.8000000000002), core sums whole centavos.
//
// One intended difference is asserted rather than matched: POS-bir never expects store-credit payments
// taken by GCash/Maya/card, so core's theoretical amount for those is POS-bir's plus the payments.
import { describe, expect, it } from "vitest"
import {
  CashMovementRecordSchema,
  CreditLedgerEntryRecordSchema,
  ShiftCloseRecordSchema,
  ShiftOpenRecordSchema,
  TransactionRecordSchema,
  ZReadingRecordSchema,
} from "../src/model"
import type {
  CashMovementRecord,
  CreditLedgerEntryRecord,
  CreditNoteRecord,
  SaleRecord,
  ShiftCloseRecord,
  ShiftOpenRecord,
  TransactionRecord,
  ZReadingRecord,
} from "../src/model"
import { roundMoney } from "../src/ph-tax"
import { buildCashMovement, buildShiftOpen, computeShiftClose, findOpenShift } from "../src/shift"
import type { ShiftErrorCode } from "../src/shift"
import { computeZReading, previewZReading, terminalCounters } from "../src/z-reading"
import type { ZReadingBoundary, ZReadingData } from "../src/z-reading"
import fixtures from "./fixtures/pc-shift-z-parity.json"

type Row = Record<string, any>
interface Step {
  kind: "open_shift" | "sale" | "void" | "credit_payment" | "cash_movement" | "close_shift" | "z_preview" | "z_reading" | "add_terminal"
  name: string
  at: string
  status?: number
  request?: Row
  response?: Row
  audit?: Row | null
  shiftId?: string | null
  transactionId?: string
  creditNoteId?: string
  ledgerIds?: string[]
  cashMovementIds?: string[]
  terminalAfter?: Row
  terminal?: Row
  zReadingsSoFar?: number
}
interface Fixture {
  generatedFrom: string
  initial: { users: Row[]; settingsGrandTotal: string }
  steps: Step[]
  tables: { transactions: Row[]; shifts: Row[]; cash_movements: Row[]; credit_ledger: Row[] }
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
const MANAGER = "user-manager" // authorizes the Z-readings
const at = (pc: string) => new Date(`${pc.replace(" ", "T")}Z`) // SQLite UTC "YYYY-MM-DD HH:MM:SS"
const iso = (pc: string) => at(pc).toISOString()
const centavo = (pc: unknown) => roundMoney(Number(pc))
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id as string, r]))

const pcTransactions = byId(f.tables.transactions)
const pcByInvoice = new Map(f.tables.transactions.map((r) => [r.invoice_number as string, r]))
const pcShifts = byId(f.tables.shifts)
const pcMovements = byId(f.tables.cash_movements)
const pcLedger = byId(f.tables.credit_ledger)
const users = new Map(f.initial.users.map((u) => [u.id as string, { id: u.id as string, is_active: Boolean(u.is_active) }]))
const openingGrandTotal = Number(f.initial.settingsGrandTotal)

// ---- Replay state -----------------------------------------------------------------------------------

const opens: ShiftOpenRecord[] = []
const closes: ShiftCloseRecord[] = []
const transactions: TransactionRecord[] = []
const movements: CashMovementRecord[] = []
const ledger: CreditLedgerEntryRecord[] = []
const lastZ = new Map<string, ZReadingBoundary>() // per terminal
const seqs = new Map<string, number>() // last device_seq per terminal
const nextSeq = (terminalId: string) => {
  const seq = (seqs.get(terminalId) ?? 0) + 1
  seqs.set(terminalId, seq)
  return seq
}
const terminalOf = (shiftId: string) => pcShifts.get(shiftId)!.terminal_id as string
const terminalBase = (terminalId: string, id: string, pcTime: string) => ({
  id,
  store_id: STORE,
  terminal_id: terminalId,
  device_seq: nextSeq(terminalId),
  created_at: iso(pcTime),
})

/** A POS-bir transactions row as the tablet records it (VOIDED is derived, so sales stay PAID) */
function toTransactionRecord(row: Row, shiftId: string): TransactionRecord {
  const common = {
    ...terminalBase(terminalOf(shiftId), row.id, row.created_at),
    shift_id: shiftId,
    cashier_id: null,
    pax_count: row.pax_count,
    senior_count: row.senior_count,
    sc_pwd_id: row.sc_pwd_id,
    sc_pwd_name: row.sc_pwd_name,
    payment_method: row.payment_method,
    gross_sales: row.gross_sales,
    vatable_sales: row.vatable_sales,
    vat_amount: row.vat_amount,
    vat_exempt_sales: row.vat_exempt_sales,
    zero_rated_sales: row.zero_rated_sales,
    total_discount: row.total_discount,
    net_sales: row.net_sales,
  }
  if (row.transaction_type === "VOID_REFUND") {
    const creditNote: CreditNoteRecord = {
      ...common,
      invoice_number: row.invoice_number,
      transaction_type: "VOID_REFUND",
      status: "REFUND",
      original_transaction_id: pcByInvoice.get(row.reference_number)!.id,
      void_reason: row.void_reason,
      authorized_by: row.void_authorized_by,
      amount_tendered: 0,
      change_amount: 0,
      reference_number: row.reference_number,
    }
    return creditNote
  }
  const sale: SaleRecord = {
    ...common,
    invoice_number: row.invoice_number,
    transaction_type: "SALE",
    status: "PAID",
    original_transaction_id: null,
    void_reason: null, // POS-bir writes the void onto the sale; here the credit note carries it
    authorized_by: null,
    amount_tendered: row.amount_tendered,
    change_amount: row.change_amount,
    reference_number: row.reference_number,
  }
  return sale
}

/** A POS-bir credit_ledger row; POS-bir kept the payment method only inside notes */
function toLedgerEntry(row: Row, shiftId: string, payment?: Row): CreditLedgerEntryRecord {
  return {
    ...terminalBase(terminalOf(shiftId), row.id, row.occurred_at),
    customer_id: row.customer_id,
    transaction_id: row.transaction_id,
    shift_id: shiftId,
    entry_type: row.entry_type,
    amount: row.amount,
    running_balance: row.running_balance,
    notes: row.notes,
    payment_method: payment?.paymentMethod ?? null,
    reference_number: payment?.reference ?? null,
  }
}

// ---- Replay -----------------------------------------------------------------------------------------

interface Outcome {
  step: Step
  result: any
  /** device_seq the record should get: one after the terminal's last record */
  expectedSeq: number
  /** ids/seqs the call took (a refusal must take none) */
  taken: { ids: number; seqs: number }
  userId: string | null
  pcSalesCount?: number | null
}
const outcomes: Outcome[] = []
let lastPcZ: Step | null = null
let pcPreviewCount: number | null = null

/** Context for a core call; counts what it takes so a refusal can be shown to create nothing */
function ctxFor(terminalId: string, userId: string | null, step: Step, id: string) {
  const taken = { ids: 0, seqs: 0 }
  const expectedSeq = (seqs.get(terminalId) ?? 0) + 1
  return {
    taken,
    expectedSeq,
    ctx: {
      storeId: STORE,
      terminalId,
      userId,
      now: at(step.at),
      newId: () => (taken.ids++, id), // POS-bir's id, so later steps can refer to it
      nextSeq: () => (taken.seqs++, nextSeq(terminalId)),
    },
  }
}
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
      const call = ctxFor(terminalId, body.userId ?? null, step, step.response?.id ?? "refused")
      const result = buildShiftOpen(
        { openingFund: body.openingFund },
        { user: users.get(body.userId) ?? null, openShift: findOpenShift(opens, closes, terminalId), counters: counters(terminalId) },
        call.ctx
      )
      if (result.ok) opens.push(result.shift)
      outcomes.push({ step, result, ...call, userId: call.ctx.userId })
      break
    }
    case "sale":
    case "void":
      transactions.push(toTransactionRecord(pcTransactions.get((step.transactionId ?? step.creditNoteId)!)!, step.shiftId!))
      for (const id of step.ledgerIds ?? []) ledger.push(toLedgerEntry(pcLedger.get(id)!, step.shiftId!))
      break
    case "credit_payment":
      // As buildCreditPayment records it: a PAYMENT entry, and a CASH_IN for a cash payment
      for (const id of step.ledgerIds!) ledger.push(toLedgerEntry(pcLedger.get(id)!, step.shiftId!, body))
      for (const id of step.cashMovementIds!) {
        const row = pcMovements.get(id)!
        movements.push({
          ...terminalBase(terminalOf(row.shift_id), row.id, row.created_at),
          shift_id: row.shift_id,
          user_id: null,
          type: row.type,
          amount: row.amount,
          reason: row.reason,
        })
      }
      break
    case "cash_movement": {
      const shift = opens.find((s) => s.id === body.shiftId)!
      const call = ctxFor(shift.terminal_id, shift.user_id, step, step.response?.id ?? "refused")
      const result = buildCashMovement(
        { type: body.type, amount: body.amount, reason: body.reason },
        { openShift: findOpenShift(opens, closes, shift.terminal_id) },
        call.ctx
      )
      if (result.ok) movements.push(result.movement)
      outcomes.push({ step, result, ...call, userId: call.ctx.userId })
      break
    }
    case "close_shift": {
      const shift = opens.find((s) => s.id === body.shiftId)!
      const call = ctxFor(shift.terminal_id, shift.user_id, step, `close-${step.name}`)
      const result = computeShiftClose(
        { actualCash: body.actualCash, actualGcash: body.actualGcash, actualMaya: body.actualMaya, actualCard: body.actualCard },
        { shift, closes, transactions, cashMovements: movements, creditLedgerEntries: ledger, counters: counters(shift.terminal_id) },
        call.ctx
      )
      if (result.ok) closes.push(result.close)
      outcomes.push({ step, result, ...call, userId: call.ctx.userId })
      break
    }
    case "add_terminal":
      // A migrated terminal never Z-read: its previous Z is the PC's last Z-reading, which has no
      // device_seq (POS-bir continues from that GT, with the number of Z-readings so far as the counter)
      lastZ.set(step.terminal!.id, {
        terminal_id: step.terminal!.id,
        created_at: iso(lastPcZ!.response!.reading_date),
        z_counter: step.zReadingsSoFar!,
        accumulated_grand_total: lastPcZ!.response!.accumulated_grand_total,
      })
      break
    case "z_preview": {
      // POS-bir's preview is for the whole database; here it is for the terminal of the next Z
      const terminalId = f.steps.slice(i).find((s) => s.kind === "z_reading")!.request!.terminalId
      const result = previewZReading(zData(terminalId), { terminalId, now: at(step.at) })
      pcPreviewCount = Number(step.response!.count)
      outcomes.push({ step, result, expectedSeq: 0, taken: { ids: 0, seqs: 0 }, userId: null })
      break
    }
    case "z_reading": {
      const terminalId = body.terminalId
      const call = ctxFor(terminalId, MANAGER, step, step.response!.id)
      const result = computeZReading(zData(terminalId), call.ctx)
      if (result.ok) lastZ.set(terminalId, result.reading)
      outcomes.push({ step, result, ...call, userId: MANAGER, pcSalesCount: pcPreviewCount })
      lastPcZ = step
      pcPreviewCount = null
      break
    }
  }
})

// ---- Checks -----------------------------------------------------------------------------------------

/** Identity and linkage every emitted record must carry */
function identity(o: Outcome, id: string, created: string, terminalId: string) {
  expect(o.taken, "one id and one device_seq per record").toEqual({ ids: 1, seqs: 1 })
  return { id, store_id: STORE, terminal_id: terminalId, device_seq: o.expectedSeq, created_at: iso(created) }
}

function expectSameError(o: Outcome) {
  const codes = PC_ERRORS.find(([re]) => re.test(o.step.response!.error))?.[1]
  expect(codes, `unmapped POS-bir error: ${o.step.response!.error}`).toBeDefined()
  expect(o.result.ok, "core accepted what POS-bir refused").toBe(false)
  expect(codes).toContain(o.result.code)
  expect(o.taken, "a refusal creates no record").toEqual({ ids: 0, seqs: 0 })
}

function checkOpen(o: Outcome) {
  const pc = o.step.response!
  expect(ShiftOpenRecordSchema.parse(o.result.shift)).toEqual({
    ...identity(o, pc.id, pc.start_time, pc.terminal_id),
    user_id: pc.user_id,
    opening_fund: centavo(pc.opening_fund),
    snapshot_z_counter: pc.snapshot_z_counter,
    snapshot_accumulated_total: centavo(pc.snapshot_accumulated_total),
  })
}

function checkMovement(o: Outcome) {
  const pc = o.step.response!
  expect(CashMovementRecordSchema.parse(o.result.movement)).toEqual({
    ...identity(o, pc.id, pc.created_at, terminalOf(pc.shift_id)),
    shift_id: pc.shift_id,
    user_id: o.userId,
    type: pc.type,
    amount: centavo(pc.amount),
    reason: pc.reason,
  })
}

function checkClose(o: Outcome) {
  const pc = o.step.response!
  const audit = o.step.audit!
  // Store-credit payments taken in this shift by e-wallet/card: POS-bir never expects them
  const debt = { gcash: 0, maya: 0, card: 0 }
  for (const s of f.steps) {
    if (s.kind === "credit_payment" && s.request!.shiftId === pc.id && s.request!.paymentMethod !== "CASH") {
      debt[s.request!.paymentMethod.toLowerCase() as keyof typeof debt] += Number(s.request!.amount)
    }
  }
  const expected: Row = {
    ...identity(o, `close-${o.step.name}`, pc.end_time, pc.terminal_id),
    shift_id: pc.id,
    user_id: o.userId,
    snapshot_z_counter: audit.closing_z_counter,
    snapshot_accumulated_total: centavo(audit.closing_accumulated_total),
  }
  let debtTotal = 0
  for (const method of ["cash", "gcash", "maya", "card"] as const) {
    const owed = method === "cash" ? 0 : debt[method]
    debtTotal += owed
    expected[`theoretical_${method}`] = roundMoney(centavo(pc[`theoretical_${method}`]) + owed)
    expected[`actual_${method}`] = centavo(pc[`actual_${method}`])
    expected[`${method}_variance`] = roundMoney(centavo(audit.variance[method]) - owed)
  }
  expect(centavo(pc.variance)).toBe(centavo(audit.variance.total))
  expected.variance = roundMoney(centavo(pc.variance) - debtTotal)
  expect(ShiftCloseRecordSchema.parse(o.result.close)).toEqual(expected)
  expect(o.result.creditPayments).toEqual(debt)
}

/** Z_TOTALS_SQL columns (GET preview) against core's figures */
function checkPreview(pc: Row, z: Row) {
  expect({
    count: z.sales_count,
    void_count: z.void_count,
    sales_total: z.sales_total,
    void_total: z.void_total,
    total_net: z.net_total,
    total_vat: z.total_vat,
    total_cash_sales: z.cash_sales_total,
    start_invoice: z.beginning_invoice,
    end_invoice: z.ending_invoice,
    start_credit_note: z.beginning_credit_note,
    end_credit_note: z.ending_credit_note,
  }).toEqual({
    ...pc,
    count: Number(pc.count),
    void_count: Number(pc.void_count),
    sales_total: centavo(pc.sales_total),
    void_total: centavo(pc.void_total),
    total_net: centavo(pc.total_net),
    total_vat: centavo(pc.total_vat),
    total_cash_sales: centavo(pc.total_cash_sales),
  })
}

function checkZ(o: Outcome) {
  const pc = o.step.response!
  const reading: ZReadingRecord = o.result.reading
  expect(o.pcSalesCount, "a preview precedes every Z").not.toBeNull()
  expect(ZReadingRecordSchema.parse(reading)).toEqual({
    ...identity(o, pc.id, pc.reading_date, pc.terminal_id),
    user_id: MANAGER,
    z_counter: pc.z_counter,
    sales_count: o.pcSalesCount, // POST doesn't return it; the preview just before covers the same period
    void_count: pc.void_count,
    sales_total: centavo(pc.sales_total),
    void_total: centavo(pc.void_total),
    net_total: centavo(pc.total_sales), // daily_readings.total_sales holds the net
    total_vat: centavo(pc.total_vat),
    cash_sales_total: centavo(pc.cash_breakdown.cash_sales),
    opening_funds_total: centavo(pc.cash_breakdown.beginning_funds),
    cash_in_total: centavo(pc.cash_breakdown.cash_in),
    cash_out_total: centavo(pc.cash_breakdown.cash_out),
    safe_drop_total: centavo(pc.cash_breakdown.safe_drops),
    theoretical_cash: centavo(pc.cash_breakdown.theoretical_cash),
    beginning_invoice: pc.beginning_invoice,
    ending_invoice: pc.ending_invoice,
    beginning_credit_note: pc.start_credit_note,
    ending_credit_note: pc.end_credit_note,
    beginning_grand_total: centavo(pc.beginning_grand_total),
    accumulated_grand_total: centavo(pc.accumulated_grand_total),
  })
  expect(reading.net_total).toBe(roundMoney(reading.sales_total - reading.void_total))
  // The terminal's counters afterwards
  expect(o.result.counters).toEqual({
    zCounter: o.step.terminalAfter!.last_z_counter,
    grandTotal: centavo(o.step.terminalAfter!.accumulated_grand_total),
  })
}

describe(`shifts and Z-readings match POS-bir (${f.generatedFrom})`, () => {
  it("rebuilds every POS-bir sale, credit note and ledger entry as a valid record", () => {
    expect(transactions).toHaveLength(f.tables.transactions.length)
    for (const t of transactions) TransactionRecordSchema.parse(t)
    expect(ledger).toHaveLength(f.tables.credit_ledger.length)
    for (const e of ledger) CreditLedgerEntryRecordSchema.parse(e)
  })

  it.each(outcomes.map((o) => [`${o.step.kind}: ${o.step.name}`, o] as const))("%s", (_name, o) => {
    if (o.step.status! >= 400) return expectSameError(o)
    expect(o.result.ok, `core refused: ${o.result.code} ${o.result.message}`).toBe(true)
    switch (o.step.kind) {
      case "open_shift":
        return checkOpen(o)
      case "cash_movement":
        return checkMovement(o)
      case "close_shift":
        return checkClose(o)
      case "z_preview":
        return checkPreview(o.step.response!, o.result.figures)
      case "z_reading":
        return checkZ(o)
    }
  })

  it("covers the flows the rules depend on", () => {
    const names = f.steps.map((s) => s.name)
    for (const name of [
      "void_s7_same_shift", // void in the same shift
      "void_s8_gcash_from_shift_1", // void of a previous shift's sale (reduces this shift's GCash)
      "void_s9_cash_from_shift_1",
      "void_s6_sc_sale_from_before_z1", // void of a sale from before the previous Z
      "debt_payment_cash", // expected once, through its CASH_IN
      "debt_payment_gcash", // expected by core, not by POS-bir
      "z1", "z2", "z3", // GT accumulates, counter increments; z3 is empty
      "z4_legacy_terminal", // upgraded install continuing the PC's chain
    ]) {
      expect(names).toContain(name)
    }
    const z = outcomes.filter((o) => o.step.kind === "z_reading").map((o) => o.result.reading as ZReadingRecord)
    expect(z.map((r) => r.z_counter)).toEqual([1, 2, 3, 4])
    expect(z[2]).toMatchObject({ sales_count: 0, void_count: 0, net_total: 0, beginning_invoice: null })
    const shift3 = outcomes.find((o) => o.step.name === "close_shift_3")!
    expect(shift3.step.audit!.variance.gcash).toBe(120.5) // POS-bir: an unexplained GCash surplus
    expect(shift3.result.close.gcash_variance).toBe(0)
  })
})
