// Revokes the device paired with this terminal: it can no longer sync until paired again
import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { deviceTokens } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { getDb } from "@/lib/db"
import { notFound } from "@/lib/http"
import { terminalForUser } from "@/lib/stores"

export async function POST(request: Request, { params }: { params: Promise<{ terminalId: string }> }) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const found = await terminalForUser(db, auth.user, (await params).terminalId)
  if (!found) return notFound("Terminal not found")
  const revoked = await db
    .update(deviceTokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(deviceTokens.terminal_id, found.terminal.id), isNull(deviceTokens.revoked_at)))
    .returning({ id: deviceTokens.id })
  return NextResponse.json({ revoked: revoked.length })
}
