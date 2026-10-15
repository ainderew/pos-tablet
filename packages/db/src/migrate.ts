import path from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import type { Schema } from "./client"

/**
 * packages/db/migrations; MIGRATIONS_DIR overrides it where the source tree isn't present (the server's
 * Docker image). Resolved at runtime: bundlers would otherwise try to bundle the folder.
 */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

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
