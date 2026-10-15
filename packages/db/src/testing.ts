// A fresh, fully migrated Postgres per test file: PGlite (Postgres compiled to WebAssembly), so tests
// need neither Docker nor a database server, locally or in CI
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import { MIGRATIONS_DIR } from "./migrate"
import * as schema from "./schema"

export async function createTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return { db, client, close: () => client.close() }
}
