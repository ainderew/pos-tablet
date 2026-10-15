// Shift open, cash movements and shift close: the same rules as POS-bir's POST /api/shifts/current,
// POST /api/cash-movements and POST /api/shifts/close, as pure functions. The caller (tablet, server
// or PC data layer) supplies this terminal's records, saves the returned record in one local
// transaction, and queues it for sync. A shift is open while its ShiftOpenRecord has no
// ShiftCloseRecord (findOpenShift).
//
// Expected drawer, as in POS-bir: per payment method, the net of the shift's sales (including ones
// voided later) and credit notes, so a void made during this shift, even of an earlier shift's sale,
// reduces this shift's drawer. Cash also adds the opening fund and CASH_IN, and takes out CASH_OUT and
// SAFE_DROP. STORE_CREDIT never reaches the drawer.
//
// Differences from POS-bir, all deliberate:
// - Records belong to a shift through shift_id (a credit note carries the shift it was issued in), so
//   the close sums exactly this shift's records on this terminal. POS-bir sums every transaction of the
//   machine (pos_id) from start_time to now at one-second resolution, so a sale in the same second as
//   the shift opened, but before it, counted in both shifts. With one shift at a time, the totals are
//   the same.
// - One open shift per terminal; POS-bir allows one per database. The terminal comes from ctx (the
//   device's pairing), so POS-bir's "Terminal ID is required" / "Terminal not found" have no equivalent.
// - Amounts are checked (finite; opening fund and counted amounts not negative; movements above zero)
//   and rounded to centavos. POS-bir stores whatever it is sent (negative, or text). A movement must
//   go into the open shift; POS-bir accepts any shift id, even a closed shift's, whose close has
//   already been computed. A reason of only spaces counts as missing.
// - Totals are summed in integer centavos, so they carry no float noise (POS-bir's SUM can give
//   1221.8000000000002).
// - Counted GCash/Maya/card amounts left out are 0, as the PC's closing dialog sends them; the
//   per-method variances are on the record (POS-bir keeps them only in the audit log).
import { roundMoney, toCents } from "./ph-tax"
import { CASH_MOVEMENT_TYPES } from "./model"
import type {
  CashMovementRecord,
  CashMovementType,
  ShiftCloseRecord,
  ShiftOpenRecord,
  TransactionRecord,
} from "./model"
import type { TerminalCounters } from "./z-reading"

export interface ShiftContext {
  storeId: string
  terminalId: string
  /** The signed-in user doing this (required to open a shift) */
  userId: string | null
  now: Date
  newId: () => string
}

export type ShiftErrorCode =
  | "USER_REQUIRED"
  | "SHIFT_ALREADY_OPEN"
  | "USER_NOT_FOUND"
  | "USER_INACTIVE"
  | "INVALID_OPENING_FUND"
  | "NO_OPEN_SHIFT"
  | "MISSING_DETAILS"
  | "INVALID_MOVEMENT_TYPE"
  | "INVALID_AMOUNT"
  | "MISSING_ACTUAL_CASH"
  | "SHIFT_NOT_FOUND"
  | "SHIFT_ALREADY_CLOSED"
  | "INVALID_ACTUAL_AMOUNT"

export interface ShiftError {
  ok: false
  code: ShiftErrorCode
  message: string
}

const fail = (code: ShiftErrorCode, message: string): ShiftError => ({ ok: false, code, message })
const fromCents = (cents: number) => cents / 100

/** A number or a numeric string (form input); undefined when absent, NaN when not numeric */
function readAmount(value: number | string | null | undefined): number | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined
  return typeof value === "number" ? value : Number(value)
}

/** This terminal's open shift: its latest ShiftOpenRecord without a ShiftCloseRecord (GET /api/shifts/current) */
export function findOpenShift(
  opens: readonly ShiftOpenRecord[],
  closes: readonly Pick<ShiftCloseRecord, "shift_id">[],
  terminalId: string
): ShiftOpenRecord | null {
  const closed = new Set(closes.map((c) => c.shift_id))
  let open: ShiftOpenRecord | null = null
  for (const s of opens) {
    if (s.terminal_id !== terminalId || closed.has(s.id)) continue
    if (!open || Date.parse(s.created_at) > Date.parse(open.created_at)) open = s
  }
  return open
}

// ---- Open -----------------------------------------------------------------------------------------

export interface ShiftOpenRequest {
  /** Cash in the drawer at the start; blank means 0 */
  openingFund?: number | string | null
}

export interface ShiftUser {
  id: string
  is_active: boolean
}

export interface ShiftOpenData {
  /** ctx.userId's user row, if found */
  user: ShiftUser | null
  /** This terminal's open shift (findOpenShift), if any */
  openShift: ShiftOpenRecord | null
  /** The terminal's counters now (terminalCounters), snapshotted on the shift */
  counters: TerminalCounters
}

export interface ShiftOpenResult {
  ok: true
  shift: ShiftOpenRecord
}

export function buildShiftOpen(request: ShiftOpenRequest, data: ShiftOpenData, ctx: ShiftContext): ShiftOpenResult | ShiftError {
  // 1. Same checks as POS-bir, in its order: a user, no open shift, the user exists and is active
  if (!ctx.userId) return fail("USER_REQUIRED", "User ID is required")
  if (data.openShift && data.openShift.terminal_id === ctx.terminalId) {
    return fail("SHIFT_ALREADY_OPEN", "A shift is already open")
  }
  const user = data.user
  if (!user || user.id !== ctx.userId) return fail("USER_NOT_FOUND", "User not found")
  if (!user.is_active) return fail("USER_INACTIVE", "User is not active")

  // 2. Opening fund (POS-bir: openingFund || 0, unchecked)
  const openingFund = readAmount(request.openingFund) ?? 0
  if (!Number.isFinite(openingFund) || openingFund < 0) {
    return fail("INVALID_OPENING_FUND", "Opening fund must be zero or more")
  }

  // 3. Record, snapshotting the terminal's counters (BIR)
  return {
    ok: true,
    shift: {
      id: ctx.newId(),
      store_id: ctx.storeId,
      terminal_id: ctx.terminalId,
      created_at: ctx.now.toISOString(),
      user_id: ctx.userId,
      opening_fund: roundMoney(openingFund),
      snapshot_z_counter: data.counters.zCounter,
      snapshot_accumulated_total: data.counters.grandTotal,
    },
  }
}

// ---- Cash movements -------------------------------------------------------------------------------

export interface CashMovementRequest {
  type?: string | null
  amount?: number | string | null
  reason?: string | null
}

export interface CashMovementData {
  /** This terminal's open shift (findOpenShift); the movement goes into it */
  openShift: ShiftOpenRecord | null
}

export interface CashMovementResult {
  ok: true
  movement: CashMovementRecord
}

export function buildCashMovement(
  request: CashMovementRequest,
  data: CashMovementData,
  ctx: ShiftContext
): CashMovementResult | ShiftError {
  // 1. Into this terminal's open shift
  const shift = data.openShift
  if (!shift || shift.terminal_id !== ctx.terminalId) return fail("NO_OPEN_SHIFT", "No shift is open")

  // 2. Same checks as POS-bir, in its order: every field given (an amount of 0 counts as missing),
  //    then a known type
  const reason = typeof request.reason === "string" ? request.reason.trim() : ""
  if (!request.type || !request.amount || !reason) return fail("MISSING_DETAILS", "Missing movement details")
  if (!(CASH_MOVEMENT_TYPES as readonly string[]).includes(request.type)) {
    return fail("INVALID_MOVEMENT_TYPE", "Invalid movement type")
  }

  // 3. A positive amount in centavos
  const amount = readAmount(request.amount)
  if (amount === undefined || !Number.isFinite(amount) || toCents(amount) <= 0) {
    return fail("INVALID_AMOUNT", "Amount must be more than zero")
  }

  return {
    ok: true,
    movement: {
      id: ctx.newId(),
      store_id: ctx.storeId,
      terminal_id: ctx.terminalId,
      created_at: ctx.now.toISOString(),
      shift_id: shift.id,
      user_id: ctx.userId,
      type: request.type as CashMovementType,
      amount: roundMoney(amount),
      reason,
    },
  }
}

// ---- Close ----------------------------------------------------------------------------------------

/** Counted amounts; GCash, Maya and card left out are 0 */
export interface ShiftCloseRequest {
  actualCash?: number | string | null
  actualGcash?: number | string | null
  actualMaya?: number | string | null
  actualCard?: number | string | null
}

export interface ShiftCloseData {
  /** The shift to close */
  shift: ShiftOpenRecord | null
  /** This terminal's close records, to refuse closing a shift twice */
  closes?: readonly Pick<ShiftCloseRecord, "shift_id">[]
  /** This terminal's sales and credit notes; only this shift's count */
  transactions: readonly TransactionRecord[]
  /** This terminal's cash movements; only this shift's count */
  cashMovements: readonly CashMovementRecord[]
  /** The terminal's counters now (terminalCounters), snapshotted on the close */
  counters: TerminalCounters
}

/** How theoretical_cash was reached, for the closing screen */
export interface ShiftCashBreakdown {
  openingFund: number
  cashSales: number // net of cash credit notes
  cashIn: number
  cashOut: number
  safeDrops: number
}

export interface ShiftCloseResult {
  ok: true
  close: ShiftCloseRecord
  cash: ShiftCashBreakdown
}

export function computeShiftClose(
  request: ShiftCloseRequest,
  data: ShiftCloseData,
  ctx: ShiftContext
): ShiftCloseResult | ShiftError {
  // 1. Same checks as POS-bir, in its order: counted cash given, then an open shift
  const counted = {
    cash: readAmount(request.actualCash),
    gcash: readAmount(request.actualGcash) ?? 0,
    maya: readAmount(request.actualMaya) ?? 0,
    card: readAmount(request.actualCard) ?? 0,
  }
  if (counted.cash === undefined) return fail("MISSING_ACTUAL_CASH", "Missing shift details")
  const shift = data.shift
  if (!shift || shift.terminal_id !== ctx.terminalId) return fail("SHIFT_NOT_FOUND", "Shift not found or already closed")
  if (data.closes?.some((c) => c.shift_id === shift.id)) {
    return fail("SHIFT_ALREADY_CLOSED", "Shift not found or already closed")
  }
  for (const value of Object.values(counted)) {
    if (!Number.isFinite(value) || (value as number) < 0) {
      return fail("INVALID_ACTUAL_AMOUNT", "Counted amounts must be zero or more")
    }
  }

  // 2. Expected per payment method: this shift's sales and credit notes (every status counts)
  const ofShift = (r: { shift_id: string; terminal_id: string }) => r.shift_id === shift.id && r.terminal_id === shift.terminal_id
  const sales = { CASH: 0, GCASH: 0, MAYA: 0, CARD: 0, STORE_CREDIT: 0 }
  for (const t of data.transactions) if (ofShift(t)) sales[t.payment_method] += toCents(t.net_sales)

  // 3. Cash movements
  const moved = { CASH_IN: 0, CASH_OUT: 0, SAFE_DROP: 0 }
  for (const m of data.cashMovements) if (ofShift(m)) moved[m.type] += toCents(m.amount)

  // 4. Theoretical vs actual
  const openingFund = toCents(shift.opening_fund)
  const theoretical = {
    cash: openingFund + sales.CASH + moved.CASH_IN - moved.CASH_OUT - moved.SAFE_DROP,
    gcash: sales.GCASH,
    maya: sales.MAYA,
    card: sales.CARD,
  }
  const actual = {
    cash: toCents(counted.cash),
    gcash: toCents(counted.gcash),
    maya: toCents(counted.maya),
    card: toCents(counted.card),
  }
  const variance = {
    cash: actual.cash - theoretical.cash,
    gcash: actual.gcash - theoretical.gcash,
    maya: actual.maya - theoretical.maya,
    card: actual.card - theoretical.card,
  }

  return {
    ok: true,
    close: {
      id: ctx.newId(),
      store_id: ctx.storeId,
      terminal_id: ctx.terminalId,
      created_at: ctx.now.toISOString(),
      shift_id: shift.id,
      user_id: ctx.userId,
      theoretical_cash: fromCents(theoretical.cash),
      actual_cash: fromCents(actual.cash),
      cash_variance: fromCents(variance.cash),
      theoretical_gcash: fromCents(theoretical.gcash),
      actual_gcash: fromCents(actual.gcash),
      gcash_variance: fromCents(variance.gcash),
      theoretical_maya: fromCents(theoretical.maya),
      actual_maya: fromCents(actual.maya),
      maya_variance: fromCents(variance.maya),
      theoretical_card: fromCents(theoretical.card),
      actual_card: fromCents(actual.card),
      card_variance: fromCents(variance.card),
      variance: fromCents(variance.cash + variance.gcash + variance.maya + variance.card),
      snapshot_z_counter: data.counters.zCounter,
      snapshot_accumulated_total: data.counters.grandTotal,
    },
    cash: {
      openingFund: fromCents(openingFund),
      cashSales: fromCents(sales.CASH),
      cashIn: fromCents(moved.CASH_IN),
      cashOut: fromCents(moved.CASH_OUT),
      safeDrops: fromCents(moved.SAFE_DROP),
    },
  }
}
