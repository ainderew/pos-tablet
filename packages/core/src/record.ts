// What every record-creating builder needs from its caller: identity, clock, and two counters the
// terminal's data layer persists (ids, and device_seq in creation order)
export interface RecordContext {
  storeId: string
  terminalId: string
  now: Date
  newId: () => string
  /** Next device_seq on this terminal; must increase by one per record created, across restarts */
  nextSeq: () => number
}

export function recordBase(ctx: RecordContext) {
  return {
    id: ctx.newId(),
    store_id: ctx.storeId,
    terminal_id: ctx.terminalId,
    device_seq: ctx.nextSeq(),
    created_at: ctx.now.toISOString(),
  }
}

/** Sum stock quantities in thousandths, so weights like 0.7 - 0.4 - 0.3 come to exactly 0 */
export function sumQuantities(...quantities: number[]): number {
  return quantities.reduce((sum, q) => sum + Math.round(q * 1000), 0) / 1000
}
