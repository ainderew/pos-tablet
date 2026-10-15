// The signed-in back-office user, checked on the server from the session cookie (never client state)
import { cookies } from "next/headers"
import { MANAGERS } from "@/lib/auth/guard"
import { loadSession, SESSION_COOKIE } from "@/lib/auth/session"
import type { SessionUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db"

export async function getBackOfficeUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const user = await loadSession(getDb(), token)
  // Someone demoted to cashier while signed in no longer has a back office
  return user && MANAGERS.includes(user.role) ? user : null
}
