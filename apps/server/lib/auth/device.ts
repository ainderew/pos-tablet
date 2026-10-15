// Device (tablet / PC) authentication: "Authorization: Bearer <token>" issued at pairing
import { and, eq, isNull } from "drizzle-orm"
import { deviceTokens, stores, terminals } from "@pos/db"
import { getDb } from "../db"
import { errorResponse } from "../http"
import { sha256 } from "./crypto"

export interface AuthedDevice {
  tokenId: string
  terminal: typeof terminals.$inferSelect
  store: typeof stores.$inferSelect
}

const TOUCH_EVERY_MS = 60 * 1000

export async function requireDevice(request: Request, now = new Date()): Promise<{ ok: true; device: AuthedDevice } | { ok: false; response: Response }> {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) return { ok: false, response: errorResponse(401, "DEVICE_UNAUTHORIZED", "Missing device token") }

  const db = getDb()
  const [row] = await db
    .select({ token: deviceTokens, terminal: terminals, store: stores })
    .from(deviceTokens)
    .innerJoin(terminals, eq(terminals.id, deviceTokens.terminal_id))
    .innerJoin(stores, eq(stores.id, terminals.store_id))
    .where(and(eq(deviceTokens.token_hash, sha256(token)), isNull(deviceTokens.revoked_at), isNull(terminals.revoked_at), isNull(terminals.deleted_at)))
  if (!row) return { ok: false, response: errorResponse(401, "DEVICE_UNAUTHORIZED", "This device is not paired (or was unpaired)") }

  // Last seen lives on the token, which isn't synced, so heartbeats don't bump the terminal's version
  if (!row.token.last_used_at || now.getTime() - row.token.last_used_at.getTime() > TOUCH_EVERY_MS) {
    const appVersion = request.headers.get("x-app-version")
    await db
      .update(deviceTokens)
      .set({ last_used_at: now, ...(appVersion ? { app_version: appVersion.slice(0, 64) } : {}) })
      .where(eq(deviceTokens.id, row.token.id))
  }
  return { ok: true, device: { tokenId: row.token.id, terminal: row.terminal, store: row.store } }
}
