import { NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/guard"

export async function GET(request: Request) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const { id, full_name, role, email, org_id, storeIds } = auth.user
  return NextResponse.json({ user: { id, full_name, role, email, org_id, store_ids: storeIds } })
}
