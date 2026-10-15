import { NextResponse } from "next/server"
import { requireDevice } from "@/lib/auth/device"
import { getDb } from "@/lib/db"
import { errorResponse } from "@/lib/http"
import { DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT, pullChanges } from "@/lib/sync/pull"

export async function GET(request: Request) {
  const auth = await requireDevice(request)
  if (!auth.ok) return auth.response
  const url = new URL(request.url)
  const cursor = Number(url.searchParams.get("cursor") ?? 0)
  const limit = Number(url.searchParams.get("limit") ?? DEFAULT_PULL_LIMIT)
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_LIMIT) {
    return errorResponse(400, "INVALID_INPUT", `cursor must be a non-negative integer and limit 1-${MAX_PULL_LIMIT}`)
  }
  return NextResponse.json(await pullChanges(getDb(), auth.device, cursor, limit))
}
