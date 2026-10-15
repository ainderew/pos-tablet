// Shifts, cash movements and Z-readings
import { z } from "zod"
import { id, money, TerminalRecordSchema } from "./common"

/** Opening a shift; its id is the shift_id other records refer to */
export const ShiftOpenRecordSchema = TerminalRecordSchema.extend({
  user_id: id,
  opening_fund: money,
  // The terminal's counters when the shift opened (they only advance on a Z-reading)
  snapshot_z_counter: z.number().int().min(0),
  snapshot_accumulated_total: money,
})
export type ShiftOpenRecord = z.infer<typeof ShiftOpenRecordSchema>

/**
 * Closing a shift: expected (theoretical) vs counted (actual) amounts per payment method.
 * Theoretical amounts are the net of the shift's sales and credit notes for that method; cash also
 * adds the opening fund and cash movements. STORE_CREDIT never reaches the drawer.
 */
export const ShiftCloseRecordSchema = TerminalRecordSchema.extend({
  shift_id: id,
  user_id: id.nullable(),
  theoretical_cash: money,
  actual_cash: money,
  cash_variance: money, // actual - theoretical, for each method
  theoretical_gcash: money,
  actual_gcash: money,
  gcash_variance: money,
  theoretical_maya: money,
  actual_maya: money,
  maya_variance: money,
  theoretical_card: money,
  actual_card: money,
  card_variance: money,
  variance: money, // total of the four variances (POS-bir's shifts.variance)
  // The terminal's counters at close (POS-bir logs them as closing_z_counter / closing_accumulated_total)
  snapshot_z_counter: z.number().int().min(0),
  snapshot_accumulated_total: money,
})
export type ShiftCloseRecord = z.infer<typeof ShiftCloseRecordSchema>

export const CASH_MOVEMENT_TYPES = ["CASH_IN", "CASH_OUT", "SAFE_DROP"] as const
export const CashMovementTypeSchema = z.enum(CASH_MOVEMENT_TYPES)
export type CashMovementType = z.infer<typeof CashMovementTypeSchema>

export const CashMovementRecordSchema = TerminalRecordSchema.extend({
  shift_id: id,
  user_id: id.nullable(),
  type: CashMovementTypeSchema,
  amount: money.positive(), // CASH_IN adds to the drawer; CASH_OUT and SAFE_DROP take out
  reason: z.string().min(1),
})
export type CashMovementRecord = z.infer<typeof CashMovementRecordSchema>

/**
 * End-of-day Z-reading for one terminal. It covers this terminal's records created after its
 * previous Z-reading, up to its own created_at. The grand total only ever changes here; it goes
 * down when credit notes for sales in an earlier Z outweigh the period's sales.
 */
export const ZReadingRecordSchema = TerminalRecordSchema.extend({
  user_id: id.nullable(),
  z_counter: z.number().int().min(1),
  sales_count: z.number().int().min(0),
  void_count: z.number().int().min(0),
  sales_total: money, // sales issued in the period (including ones voided later)
  void_total: money, // positive: credit notes issued in the period
  net_total: money, // sales_total - void_total
  total_vat: money, // net of credit notes
  cash_sales_total: money, // CASH sales net of CASH credit notes
  // Cash breakdown (POS-bir's cash_breakdown): shifts opened and cash moved in the period
  opening_funds_total: money,
  cash_in_total: money,
  cash_out_total: money,
  safe_drop_total: money,
  theoretical_cash: money, // opening funds + cash sales + cash in - cash out - safe drops
  beginning_invoice: z.string().nullable(),
  ending_invoice: z.string().nullable(),
  beginning_credit_note: z.string().nullable(),
  ending_credit_note: z.string().nullable(),
  beginning_grand_total: money,
  accumulated_grand_total: money, // ending grand total: beginning + net_total
})
export type ZReadingRecord = z.infer<typeof ZReadingRecordSchema>
