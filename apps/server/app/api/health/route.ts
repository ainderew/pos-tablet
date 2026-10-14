import { NextResponse } from "next/server"

// Liveness check for nginx/uptime monitoring; the database check is added with Postgres in Phase 2
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "pos-server",
    version: process.env.APP_VERSION ?? "dev",
    time: new Date().toISOString(),
  })
}
