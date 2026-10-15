// Runs once when the server process starts: brings the database schema up to date before any
// request is served (an advisory lock keeps concurrent starts from migrating twice)
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return
  const { createDb } = await import("@pos/db")
  const { runMigrations } = await import("@pos/db/migrate")
  const { db, close } = createDb(process.env.DATABASE_URL)
  try {
    await runMigrations(db)
    console.log("[v0] Database migrations are up to date")
  } finally {
    await close()
  }
}
