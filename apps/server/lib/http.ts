import { NextResponse } from "next/server"
import type { z } from "zod"

/** Every error response has this shape: { error: { code, message, issues? } } */
export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status })
}

export const unauthorized = () => errorResponse(401, "UNAUTHORIZED", "Sign in to continue")
export const forbidden = () => errorResponse(403, "FORBIDDEN", "You don't have access to this")
export const notFound = (what = "Not found") => errorResponse(404, "NOT_FOUND", what)

/** Parse and validate a JSON body; on failure returns a 400 with the zod issues */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false, response: errorResponse(400, "INVALID_JSON", "Request body must be JSON") }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    return { ok: false, response: errorResponse(400, "INVALID_INPUT", "Some fields are invalid", { issues }) }
  }
  return { ok: true, data: parsed.data }
}

/** Client IP as nginx forwards it (X-Real-IP / X-Forwarded-For), for rate limits and session records */
export function clientIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  )
}
