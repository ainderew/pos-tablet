import { NextResponse } from "next/server"
import { sql } from "drizzle-orm"
import { getDb } from "@/lib/db"

// Liveness for nginx/uptime monitoring: the process answers and the database is reachable
export async function GET() {
  let database: "up" | "down" = "down"
  try {
    await getDb().execute(sql`select 1`)
    database = "up"
  } catch (error) {
    console.error("[v0] Health check: database unreachable", error)
  }
  return NextResponse.json(
    {
      ok: database === "up",
      service: "pos-server",
      version: process.env.APP_VERSION ?? "dev",
      database,
      time: new Date().toISOString(),
    },
    { status: database === "up" ? 200 : 503 }
  )
}
