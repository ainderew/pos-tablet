// Postgres errors behind Drizzle's wrapper (DrizzleQueryError keeps the driver's error as `cause`)

type PgError = { code: string; constraint?: string }

export function pgError(err: unknown): PgError | null {
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      return { code: e.code, constraint: typeof e.constraint === "string" ? e.constraint : undefined }
    }
    current = e.cause
  }
  return null
}

/** A unique index refused the write (optionally: this index), e.g. two managers saving the same barcode at once */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err)
  if (!pg || pg.code !== "23505") return false
  return !constraint || !pg.constraint || pg.constraint === constraint
}
