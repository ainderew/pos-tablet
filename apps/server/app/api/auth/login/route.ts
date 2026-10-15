import { NextResponse } from "next/server"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { users } from "@pos/db"
import { isSameOrigin, MANAGERS } from "@/lib/auth/guard"
import { verifyPassword } from "@/lib/auth/passwords"
import { createSession, sessionCookie } from "@/lib/auth/session"
import { getDb } from "@/lib/db"
import { clientIp, errorResponse } from "@/lib/http"
import { clearRateLimit, isRateLimited, rateLimit } from "@/lib/rate-limit"

const LoginSchema = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) })
const WINDOW_MS = 15 * 60 * 1000
const MAX_BODY_BYTES = 4096
const tooMany = () => errorResponse(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again in 15 minutes.")

export async function POST(request: Request) {
  // Login CSRF: another site must not be able to sign the browser into a different account
  if (!isSameOrigin(request)) return errorResponse(403, "CROSS_SITE", "Cross-site request refused")
  const ip = clientIp(request)
  // Per address, before reading anything: a flood of requests costs nothing past this point
  if (!rateLimit(`login-ip:${ip}`, 30, WINDOW_MS)) return tooMany()

  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) return errorResponse(413, "TOO_LARGE", "Request too large")
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return errorResponse(413, "TOO_LARGE", "Request too large")
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be JSON")
  }
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) return errorResponse(400, "INVALID_INPUT", "Enter your email and password")
  const email = parsed.data.email.toLowerCase()

  // Failed attempts per account from this address, and per account from anywhere (distributed guessing)
  const accountKey = `login:${ip}:${email}`
  const emailKey = `login-email:${email}`
  if (isRateLimited(accountKey, 5) || isRateLimited(emailKey, 50)) return tooMany()

  const db = getDb()
  const [user] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.is_active, true), isNull(users.deleted_at), inArray(users.role, [...MANAGERS])))
  // Always run bcrypt, so an unknown email takes as long as a wrong password
  if (!(await verifyPassword(parsed.data.password, user?.password_hash))) {
    rateLimit(accountKey, 5, WINDOW_MS)
    rateLimit(emailKey, 50, WINDOW_MS)
    return errorResponse(401, "INVALID_CREDENTIALS", "Wrong email or password")
  }
  clearRateLimit(accountKey)

  const { token, expiresAt } = await createSession(db, user.id, { userAgent: request.headers.get("user-agent"), ip })
  const response = NextResponse.json({ user: { id: user.id, full_name: user.full_name, role: user.role, email: user.email } })
  response.cookies.set(sessionCookie(token, expiresAt))
  return response
}
