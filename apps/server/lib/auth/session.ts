// Back-office sessions: a random token in an httpOnly cookie; the database keeps only its SHA-256
import { and, eq, isNull } from "drizzle-orm"
import { sessions, users } from "@pos/db"
import type { Db, UserRole } from "@pos/db"
import { randomToken, sha256 } from "./crypto"

// __Host- (production, HTTPS): the browser only accepts it Secure, on "/", from this exact host
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-pos_session" : "pos_session"
const SESSION_DAYS = 7 // slides forward while in use
const MAX_SESSION_DAYS = 30 // never longer than this from sign-in
const DAY = 24 * 60 * 60 * 1000
const TOUCH_EVERY_MS = 5 * 60 * 1000

export interface SessionUser {
  id: string
  org_id: string
  full_name: string
  role: UserRole
  email: string | null
}

export async function createSession(db: Db, userId: string, meta: { userAgent?: string | null; ip?: string | null } = {}, now = new Date()) {
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY)
  // The cookie itself lasts the absolute maximum: the server-side expiry slides within it, and the
  // cookie is only set at sign-in, so a shorter cookie would sign active users out on day 7
  const cookieExpiresAt = new Date(now.getTime() + MAX_SESSION_DAYS * DAY)
  await db.insert(sessions).values({
    token_hash: sha256(token),
    user_id: userId,
    created_at: now,
    expires_at: expiresAt,
    last_used_at: now,
    user_agent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  })
  return { token, expiresAt: cookieExpiresAt }
}

/** The signed-in user for a session token, or null (expired, unknown, or the user was deactivated) */
export async function loadSession(db: Db, token: string | null | undefined, now = new Date()): Promise<SessionUser | null> {
  if (!token) return null
  const tokenHash = sha256(token)
  const [row] = await db
    .select({
      session: sessions,
      user: { id: users.id, org_id: users.org_id, full_name: users.full_name, role: users.role, email: users.email },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.user_id))
    .where(and(eq(sessions.token_hash, tokenHash), eq(users.is_active, true), isNull(users.deleted_at)))
  if (!row || row.session.expires_at <= now) return null

  // Slide the expiry forward, at most every few minutes, never past the absolute maximum
  if (now.getTime() - row.session.last_used_at.getTime() > TOUCH_EVERY_MS) {
    const cap = row.session.created_at.getTime() + MAX_SESSION_DAYS * DAY
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_DAYS * DAY, cap))
    await db.update(sessions).set({ last_used_at: now, expires_at: expiresAt }).where(eq(sessions.token_hash, tokenHash))
  }
  return row.user
}

export async function destroySession(db: Db, token: string | null | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.token_hash, sha256(token)))
}

/** Sign a user out everywhere (password change, deactivation) */
export async function destroyUserSessions(db: Db, userId: string) {
  await db.delete(sessions).where(eq(sessions.user_id, userId))
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key !== name) continue
    try {
      return decodeURIComponent(rest.join("="))
    } catch {
      return null // malformed cookie: treat as signed out, not a 500
    }
  }
  return null
}
