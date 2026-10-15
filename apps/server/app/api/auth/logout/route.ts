import { NextResponse } from "next/server"
import { isSameOrigin } from "@/lib/auth/guard"
import { destroySession, readCookie, SESSION_COOKIE, sessionCookie } from "@/lib/auth/session"
import { getDb } from "@/lib/db"
import { errorResponse } from "@/lib/http"

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return errorResponse(403, "CROSS_SITE", "Cross-site request refused")
  await destroySession(getDb(), readCookie(request, SESSION_COOKIE))
  const response = NextResponse.json({ ok: true })
  response.cookies.set({ ...sessionCookie("", new Date(0)), maxAge: 0 })
  return response
}
