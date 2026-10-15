// Fixed-window limiter in process memory: enough for one server instance (login, pairing). Expired
// windows are swept out and the table is capped, so a flood of distinct keys can't exhaust memory.
const windows = new Map<string, { count: number; resetAt: number }>()
const MAX_KEYS = 50_000
const SWEEP_EVERY_MS = 60_000
let lastSweep = 0

function sweep(now: number) {
  if (now - lastSweep < SWEEP_EVERY_MS && windows.size < MAX_KEYS) return
  lastSweep = now
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key)
}

/** Counts one attempt for `key`; returns false once `limit` attempts happened within `windowMs` */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  sweep(now)
  const current = windows.get(key)
  if (!current || current.resetAt <= now) {
    // Table full of live windows (an attack with many addresses): refuse new keys rather than grow
    if (!current && windows.size >= MAX_KEYS) return false
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  current.count++
  return current.count <= limit
}

/** Whether `key` has used up `limit` in its current window, without counting an attempt */
export function isRateLimited(key: string, limit: number, now = Date.now()): boolean {
  const current = windows.get(key)
  return !!current && current.resetAt > now && current.count >= limit
}

export function clearRateLimit(key: string) {
  windows.delete(key)
}

export function resetRateLimits() {
  windows.clear()
  lastSweep = 0
}

export const rateLimitKeyCount = () => windows.size
