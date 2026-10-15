import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import type { Schema } from "./client"

/** packages/db/migrations (override with MIGRATIONS_DIR where the source tree isn't present) */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url))

// Arbitrary constant for pg_advisory_lock, so two server instances never migrate at once
const MIGRATION_LOCK = 7_250_419

export async function runMigrations(db: NodePgDatabase<Schema>, migrationsFolder = MIGRATIONS_DIR) {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`)
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`)
  }
}
