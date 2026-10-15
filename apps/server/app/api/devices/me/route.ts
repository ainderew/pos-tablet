import { NextResponse } from "next/server"
import { requireDevice } from "@/lib/auth/device"
import { storeForDevice } from "@/lib/stores"

export async function GET(request: Request) {
  const auth = await requireDevice(request)
  if (!auth.ok) return auth.response
  const { terminal, store } = auth.device
  return NextResponse.json({
    terminal: { id: terminal.id, name: terminal.name, kind: terminal.kind, store_id: terminal.store_id },
    store: storeForDevice(store),
    server_time: new Date().toISOString(),
  })
}
