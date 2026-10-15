// A device trades a pairing code for its bearer token. Public endpoint (the device has no token
// yet), so codes are short-lived, single-use and rate-limited per address.
import { NextResponse } from "next/server"
import { and, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import { deviceTokens, pairingCodes, stores, terminals } from "@pos/db"
import { DEVICE_TOKEN_PREFIX, normalizePairingCode, randomToken, sha256 } from "@/lib/auth/crypto"
import { getDb } from "@/lib/db"
import { clientIp, errorResponse, readJson } from "@/lib/http"
import { rateLimit } from "@/lib/rate-limit"
import { storeForDevice, terminalResumePoint } from "@/lib/stores"

const PairSchema = z.object({
  code: z.string().min(1).max(32),
  device_info: z.record(z.string(), z.unknown()).optional(),
})


export async function POST(request: Request) {
  if (!rateLimit(`pair:${clientIp(request)}`, 10, 15 * 60 * 1000)) {
    return errorResponse(429, "TOO_MANY_ATTEMPTS", "Too many pairing attempts. Try again in 15 minutes.")
  }
  const body = await readJson(request, PairSchema)
  if (!body.ok) return body.response
  const deviceInfo = JSON.parse(JSON.stringify(body.data.device_info ?? {}).slice(0, 4000) || "{}")

  const db = getDb()
  const now = new Date()
  const token = DEVICE_TOKEN_PREFIX + randomToken()
  const paired = await db.transaction(async (tx) => {
    const [code] = await tx
      .update(pairingCodes)
      .set({ used_at: now })
      .where(and(eq(pairingCodes.code_hash, sha256(normalizePairingCode(body.data.code))), isNull(pairingCodes.used_at), gt(pairingCodes.expires_at, now)))
      .returning()
    if (!code) return null
    const [row] = await tx
      .select({ terminal: terminals, store: stores })
      .from(terminals)
      .innerJoin(stores, eq(stores.id, terminals.store_id))
      .where(and(eq(terminals.id, code.terminal_id), isNull(terminals.revoked_at), isNull(terminals.deleted_at)))
    if (!row) return null
    // One device per terminal: two devices would both number records from the same device_seq
    await tx.update(deviceTokens).set({ revoked_at: now }).where(and(eq(deviceTokens.terminal_id, row.terminal.id), isNull(deviceTokens.revoked_at)))
    await tx.insert(deviceTokens).values({ terminal_id: row.terminal.id, token_hash: sha256(token), device_info: deviceInfo })
    return row
  })
  if (!paired) return errorResponse(400, "INVALID_CODE", "That pairing code is wrong or has expired")

  return NextResponse.json(
    {
      token,
      terminal: { id: paired.terminal.id, name: paired.terminal.name, kind: paired.terminal.kind, store_id: paired.terminal.store_id, ptu_number: paired.terminal.ptu_number, serial_number: paired.terminal.serial_number, min: paired.terminal.min },
      store: storeForDevice(paired.store),
      // Continue numbering after what the server already has from this terminal
      resume: await terminalResumePoint(db, paired.terminal.id),
      server_time: now.toISOString(),
    },
    { status: 201 }
  )
}
