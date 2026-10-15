import { drizzle } from "drizzle-orm/node-postgres"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import { Pool } from "pg"
import * as schema from "./schema"

export type Schema = typeof schema

/** Any Drizzle Postgres database with this schema: node-postgres in production, PGlite in tests */
export type Db = PgDatabase<PgQueryResultHKT, Schema>

export function createDb(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    // Fail fast instead of piling up requests behind a stuck connection or a long lock wait
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    idle_in_transaction_session_timeout: 60_000,
  })
  return { db: drizzle(pool, { schema }), close: () => pool.end() }
}
