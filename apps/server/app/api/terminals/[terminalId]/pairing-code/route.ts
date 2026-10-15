// Shows a one-time code (and QR payload) the device enters to pair with this terminal
import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { pairingCodes } from "@pos/db"
import { PAIRING_CODE_MINUTES, pairingCode, sha256 } from "@/lib/auth/crypto"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { getDb } from "@/lib/db"
import { errorResponse, notFound } from "@/lib/http"
import { terminalForUser } from "@/lib/stores"


export async function POST(request: Request, { params }: { params: Promise<{ terminalId: string }> }) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const found = await terminalForUser(db, auth.user, (await params).terminalId)
  if (!found) return notFound("Terminal not found")
  if (found.terminal.revoked_at) return errorResponse(409, "TERMINAL_REVOKED", "This terminal was decommissioned")

  const code = pairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_MINUTES * 60 * 1000)
  await db.transaction(async (tx) => {
    // Only the newest code works
    await tx.delete(pairingCodes).where(and(eq(pairingCodes.terminal_id, found.terminal.id), isNull(pairingCodes.used_at)))
    await tx.insert(pairingCodes).values({ code_hash: sha256(code), terminal_id: found.terminal.id, created_by: auth.user.id, expires_at: expiresAt })
  })
  const server = process.env.PUBLIC_URL ?? new URL(request.url).origin
  return NextResponse.json({
    code,
    expires_at: expiresAt.toISOString(),
    // The tablet's pairing screen scans this, so nobody types the server address
    qr_payload: JSON.stringify({ v: 1, server, code }),
  })
}
