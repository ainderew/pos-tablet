// Imports a POS-bir pos.db into the server database and prints the report as JSON (see ./pos-bir.ts):
//
//   node --experimental-strip-types packages/db/src/import/cli.ts --sqlite pos.db --database-url postgres://... \
//     --org-id <uuid> --store-id <uuid> --imported-by <uuid> [--dry-run]
//
// DATABASE_URL in the environment can replace --database-url, which keeps the password off the command
// line (deploy/import-pos-bir.sh does that). Exit codes: 0 imported (or dry run), 1 failed and nothing
// was written, 2 bad arguments. Needs Node 22.15 or later.
import * as nodeModule from "node:module"
import { parseArgs } from "node:util"
import type { Db } from "../client"

const USAGE = `usage: node --experimental-strip-types packages/db/src/import/cli.ts --sqlite <pos.db>
  [--database-url <postgres url> | DATABASE_URL=...] --org-id <uuid> --store-id <uuid> --imported-by <uuid> [--dry-run]`

function fail(message: string, code: number): never {
  console.error(message)
  process.exit(code)
}

function parse() {
  try {
    return parseArgs({
      options: {
        sqlite: { type: "string" },
        "database-url": { type: "string" },
        "org-id": { type: "string" },
        "store-id": { type: "string" },
        "imported-by": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }).values
  } catch (error) {
    fail(`${(error as Error).message}\n${USAGE}`, 2)
  }
}

const args = parse()
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}
const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL
const { sqlite, "org-id": orgId, "store-id": storeId, "imported-by": importedBy } = args
if (!sqlite || !databaseUrl || !orgId || !storeId || !importedBy) fail(USAGE, 2)

// The package's sources import each other without file extensions (as bundlers and vitest resolve
// them); Node's own resolver doesn't, so retry relative imports with ".ts" and "/index.ts"
if (typeof nodeModule.registerHooks !== "function") fail(`Node ${process.version} is too old: the importer needs Node 22.15 or later`, 1)
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith(".")) throw error
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(specifier + suffix, context)
        } catch {
          // try the next one
        }
      }
      throw error
    }
  },
})

const { createDb } = await import("../client")
const { importPosBir } = await import("./pos-bir")

const { db, close } = createDb(databaseUrl)
try {
  const report = await importPosBir(db as unknown as Db, sqlite, { orgId, storeId, importedBy }, { dryRun: args["dry-run"] })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  // Drizzle wraps database errors ("Failed query: <sql> params: <every row>"): show the cause instead
  const e = error as Error & { cause?: { message?: string; detail?: string }; errors?: Error[] }
  const message = e.cause?.message ?? (e.message || e.errors?.map((x) => x.message).join("; ") || String(error))
  console.error(`[import] failed, nothing was written: ${message}${e.cause?.detail ? ` (${e.cause.detail})` : ""}`)
  process.exitCode = 1
} finally {
  await close()
}
