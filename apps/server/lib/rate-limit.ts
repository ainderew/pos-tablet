// Fixed-window limiter in process memory: enough for one server instance (login, pairing)
const windows = new Map<string, { count: number; resetAt: number }>()

/** Counts one attempt for `key`; returns false once `limit` attempts happened within `windowMs` */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const current = windows.get(key)
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  current.count++
  return current.count <= limit
}

export function resetRateLimits() {
  windows.clear()
}
