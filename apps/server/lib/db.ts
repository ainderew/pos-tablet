import { createDb } from "@pos/db"
import type { Db } from "@pos/db"

// One pool per server process (kept on globalThis so dev hot reloads don't open new pools)
const holder = globalThis as unknown as { __posDb?: Db | null }

export function getDb(): Db {
  if (!holder.__posDb) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is not set")
    holder.__posDb = createDb(url).db as unknown as Db
  }
  return holder.__posDb
}

/** Tests swap in a PGlite database (see @pos/db/testing) */
export function setDb(db: Db | null) {
  holder.__posDb = db
}
