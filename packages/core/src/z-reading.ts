// Z-reading (end of day) for one terminal: the same totals as POS-bir's POST /api/reports/z-reading
// (its Z_TOTALS_SQL) and GET preview, as pure functions. The caller verifies the manager PIN, supplies
// this terminal's records, saves the returned reading in one local transaction, and queues it for sync.
//
// Totals, as in POS-bir:
// - Sales issued in the period count even if they were voided later; credit notes (negative amounts)
//   issued in the period net them out. A sale and its void in the same period net to zero; a void of a
//   sale already in an earlier Z appears only as its credit note, so the net (and GT) goes down.
// - The grand total accumulates the net; the Z counter goes up by one; SI and CN numbers have separate
//   ranges; cash sales are net of cash credit notes.
//
// Differences from POS-bir, all deliberate:
// - Per terminal. POS-bir sums every transaction in the database since the latest Z of any terminal.
// - The period is by creation order, not the clock: previous.device_seq < device_seq < the Z's own
//   device_seq. POS-bir uses created_at > reading_date at one-second resolution, so a sale made in the
//   same second as a Z, just after it, was in neither Z, and after the clock was set back every sale
//   stamped before the last Z fell out of every later Z and the grand total. Here each record is in
//   exactly one Z whatever the clock says. created_at is only printed; a Z dated before the previous
//   one is still refused (CLOCK_BEHIND), so the printed dates never go backwards.
// - Totals are summed in integer centavos, so they carry no float noise (POS-bir's SUM can return
//   -37.640000000000015; its GT is rounded, the other totals are not).
// - SI/CN ranges compare the number, not the text, so SI-1000000 comes after SI-999999.
// - The upgrade path (a terminal never Z-read) is resolved by the caller: the previous Z of a migrated
//   terminal is its last PC Z-reading (z_counter = PC Z count, accumulated_grand_total = its GT, and no
//   device_seq, so the first Z covers every record passed in), and openingGrandTotal is the PC's
//   settings GT when it never ran a Z (0 for a brand-new terminal).
import { toCents } from "./ph-tax"
import { recordBase } from "./record"
import type { RecordContext } from "./record"
import type { CashMovementRecord, ShiftOpenRecord, TransactionRecord, ZReadingRecord } from "./model"

/** The terminal's BIR counters now; they only change on a Z-reading */
export interface TerminalCounters {
  /** Z-readings issued so far (POS-bir's terminals.last_z_counter) */
  zCounter: number
  /** Accumulated grand total as of the last Z (terminals.accumulated_grand_total) */
  grandTotal: number
}

/**
 * What a Z-reading needs from the previous one. A migrated terminal can pass its last PC Z-reading,
 * which has no device_seq: the next Z then covers every record passed in.
 */
export type ZReadingBoundary = Pick<ZReadingRecord, "terminal_id" | "created_at" | "z_counter" | "accumulated_grand_total"> & {
  device_seq?: number | null
}

export interface ZReadingData {
  /** This terminal's sales and credit notes, in any order (the reading picks its own; other terminals' are ignored) */
  transactions: readonly TransactionRecord[]
  /** This terminal's shift opens and cash movements, for the cash breakdown */
  shiftOpens: readonly ShiftOpenRecord[]
  cashMovements: readonly CashMovementRecord[]
  /** This terminal's latest Z-reading, or null before its first */
  previous: ZReadingBoundary | null
  /** Grand total carried into the first Z when there is no previous one: 0 for a brand-new terminal */
  openingGrandTotal: number
}

export interface ZReadingContext extends RecordContext {
  /** Manager who authorized the reading */
  userId: string | null
}

/** Everything a reading records except its identity (id, store, terminal, seq, time, user) */
export type ZReadingFigures = Omit<ZReadingRecord, "id" | "store_id" | "terminal_id" | "device_seq" | "created_at" | "user_id">

export type ZReadingErrorCode = "CLOCK_BEHIND" | "TERMINAL_MISMATCH" | "INVALID_OPENING_GRAND_TOTAL"

export interface ZReadingError {
  ok: false
  code: ZReadingErrorCode
  message: string
}

export interface ZReadingPreview {
  ok: true
  /** What a Z-reading would record now (POS-bir's GET returns only the totals) */
  figures: ZReadingFigures
}

export interface ZReadingResult {
  ok: true
  reading: ZReadingRecord
  /** The terminal's counters after this reading */
  counters: TerminalCounters
}

const fail = (code: ZReadingErrorCode, message: string): ZReadingError => ({ ok: false, code, message })
const fromCents = (cents: number) => cents / 100
const documentNumber = (invoice: string) => Number(invoice.slice(invoice.indexOf("-") + 1))

/** The counters a shift open or close snapshots: the previous Z's, or the opening values before the first Z */
export function terminalCounters(previous: ZReadingBoundary | null, openingGrandTotal: number): TerminalCounters {
  return previous
    ? { zCounter: previous.z_counter, grandTotal: previous.accumulated_grand_total }
    : { zCounter: 0, grandTotal: fromCents(toCents(openingGrandTotal)) }
}

/** The Z-reading figures as of now, without recording anything (GET /api/reports/z-reading) */
export function previewZReading(
  data: ZReadingData,
  ctx: Pick<ZReadingContext, "terminalId" | "now">
): ZReadingPreview | ZReadingError {
  const error = refusal(data, ctx)
  if (error) return error
  return { ok: true, figures: figuresOf(data, ctx.terminalId, Infinity) }
}

/** Runs the Z-reading: it covers every record of this terminal created after the previous Z and before it */
export function computeZReading(data: ZReadingData, ctx: ZReadingContext): ZReadingResult | ZReadingError {
  const error = refusal(data, ctx)
  if (error) return error
  const base = recordBase(ctx)
  const reading: ZReadingRecord = { ...base, user_id: ctx.userId, ...figuresOf(data, ctx.terminalId, base.device_seq) }
  return {
    ok: true,
    reading,
    counters: { zCounter: reading.z_counter, grandTotal: reading.accumulated_grand_total },
  }
}

function refusal(data: ZReadingData, ctx: Pick<ZReadingContext, "terminalId" | "now">): ZReadingError | null {
  const previous = data.previous
  if (previous && previous.terminal_id !== ctx.terminalId) {
    return fail("TERMINAL_MISMATCH", "The previous Z-reading belongs to another terminal")
  }
  if (!previous && !Number.isFinite(data.openingGrandTotal)) {
    return fail("INVALID_OPENING_GRAND_TOTAL", "Opening grand total must be a number")
  }
  // Only the printed date: which records a Z covers never depends on the clock
  if (previous && ctx.now.getTime() < Date.parse(previous.created_at)) {
    return fail("CLOCK_BEHIND", "The clock is earlier than the last Z-reading — check the date and time")
  }
  return null
}

/** The figures for this terminal's records with previous.device_seq < device_seq < untilSeq */
function figuresOf(data: ZReadingData, terminalId: string, untilSeq: number): ZReadingFigures {
  const previous = data.previous
  const afterSeq = previous?.device_seq ?? -Infinity
  const inPeriod = (r: { terminal_id: string; device_seq: number }) =>
    r.terminal_id === terminalId && r.device_seq > afterSeq && r.device_seq < untilSeq

  // 1. Sales and credit notes issued in the period (Z_TOTALS_SQL; every status counts)
  let salesCount = 0
  let voidCount = 0
  let salesCents = 0
  let voidCents = 0 // positive, though the credit notes themselves are negative
  let vatCents = 0
  let cashSalesCents = 0
  const invoices: string[] = []
  const creditNotes: string[] = []
  for (const t of data.transactions) {
    if (!inPeriod(t)) continue
    const net = toCents(t.net_sales)
    if (t.transaction_type === "VOID_REFUND") {
      voidCount++
      voidCents -= net
      creditNotes.push(t.invoice_number)
    } else {
      salesCount++
      salesCents += net
      invoices.push(t.invoice_number)
    }
    vatCents += toCents(t.vat_amount)
    if (t.payment_method === "CASH") cashSalesCents += net
  }
  const range = (numbers: string[]) => {
    if (numbers.length === 0) return [null, null] as const
    const sorted = [...numbers].sort((a, b) => documentNumber(a) - documentNumber(b))
    return [sorted[0], sorted[sorted.length - 1]] as const
  }
  const [beginningInvoice, endingInvoice] = range(invoices)
  const [beginningCreditNote, endingCreditNote] = range(creditNotes)

  // 2. Cash breakdown: opening funds of shifts opened in the period, and cash moved in it
  let openingFundsCents = 0
  for (const s of data.shiftOpens) if (inPeriod(s)) openingFundsCents += toCents(s.opening_fund)
  const moved = { CASH_IN: 0, CASH_OUT: 0, SAFE_DROP: 0 }
  for (const m of data.cashMovements) if (inPeriod(m)) moved[m.type] += toCents(m.amount)

  // 3. Grand total and counter carry on from the previous Z
  const before = terminalCounters(previous, data.openingGrandTotal)
  const netCents = salesCents - voidCents

  return {
    z_counter: before.zCounter + 1,
    sales_count: salesCount,
    void_count: voidCount,
    sales_total: fromCents(salesCents),
    void_total: fromCents(voidCents),
    net_total: fromCents(netCents),
    total_vat: fromCents(vatCents),
    cash_sales_total: fromCents(cashSalesCents),
    opening_funds_total: fromCents(openingFundsCents),
    cash_in_total: fromCents(moved.CASH_IN),
    cash_out_total: fromCents(moved.CASH_OUT),
    safe_drop_total: fromCents(moved.SAFE_DROP),
    theoretical_cash: fromCents(openingFundsCents + cashSalesCents + moved.CASH_IN - moved.CASH_OUT - moved.SAFE_DROP),
    beginning_invoice: beginningInvoice,
    ending_invoice: endingInvoice,
    beginning_credit_note: beginningCreditNote,
    ending_credit_note: endingCreditNote,
    beginning_grand_total: before.grandTotal,
    accumulated_grand_total: fromCents(toCents(before.grandTotal) + netCents),
  }
}
