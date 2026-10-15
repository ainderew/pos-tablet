import { NextResponse } from "next/server"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { users } from "@pos/db"
import { MANAGERS } from "@/lib/auth/guard"
import { verifyPassword } from "@/lib/auth/passwords"
import { createSession, sessionCookie } from "@/lib/auth/session"
import { getDb } from "@/lib/db"
import { clientIp, errorResponse, readJson } from "@/lib/http"
import { rateLimit } from "@/lib/rate-limit"

const LoginSchema = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) })
const WINDOW_MS = 15 * 60 * 1000

export async function POST(request: Request) {
  const body = await readJson(request, LoginSchema)
  if (!body.ok) return body.response
  const email = body.data.email.toLowerCase()
  const ip = clientIp(request)
  // Per account (guessing one password) and per address (trying many accounts)
  if (!rateLimit(`login:${ip}:${email}`, 5, WINDOW_MS) || !rateLimit(`login-ip:${ip}`, 30, WINDOW_MS)) {
    return errorResponse(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again in 15 minutes.")
  }

  const db = getDb()
  const [user] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.is_active, true), isNull(users.deleted_at), inArray(users.role, [...MANAGERS])))
  // Always run bcrypt, so an unknown email takes as long as a wrong password
  if (!(await verifyPassword(body.data.password, user?.password_hash))) {
    return errorResponse(401, "INVALID_CREDENTIALS", "Wrong email or password")
  }

  const { token, expiresAt } = await createSession(db, user.id, { userAgent: request.headers.get("user-agent"), ip })
  const response = NextResponse.json({ user: { id: user.id, full_name: user.full_name, role: user.role, email: user.email } })
  response.cookies.set(sessionCookie(token, expiresAt))
  return response
}
