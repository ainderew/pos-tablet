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
    throw error
  }
}
