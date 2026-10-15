import { NextResponse } from "next/server"
import { PushRequestSchema } from "@pos/core"
import { requireDevice } from "@/lib/auth/device"
import { getDb } from "@/lib/db"
import { errorResponse, readJson } from "@/lib/http"
import { ingestPush, SyncRejection } from "@/lib/sync/ingest"

export async function POST(request: Request) {
  const auth = await requireDevice(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request, PushRequestSchema)
  if (!body.ok) return body.response
  try {
    return NextResponse.json(await ingestPush(getDb(), auth.device, body.data.records))
  } catch (error) {
    if (error instanceof SyncRejection) {
      console.warn(`[v0] Sync push rejected for terminal ${auth.device.terminal.id}: ${error.code} at seq ${error.deviceSeq}`)
      return errorResponse(error.status, error.code, error.message, { device_seq: error.deviceSeq ?? null })
    }
    // A value the database refuses is the batch's fault: answer 4xx so the device stops and reports
    // it, instead of retrying a 500 forever (22xxx: invalid data, 23xxx: constraint violations)
    const code = String((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code ?? "")
    if (code.startsWith("22") || code.startsWith("23")) {
      console.warn(`[v0] Sync push refused by the database for terminal ${auth.device.terminal.id}: ${code}`)
      return errorResponse(code.startsWith("22") ? 400 : 409, code.startsWith("22") ? "INVALID_RECORD" : "SYNC_CONFLICT", "The database refused a record in this batch", { db_code: code })
    }
    throw error
  }
}
