import { errorResponse } from "@/lib/http"
import type { Issue } from "./input"

export const invalidInput = (issues: Issue[]) => errorResponse(400, "INVALID_INPUT", "Some fields are invalid", { issues })
export const denied = (message: string) => errorResponse(403, "FORBIDDEN", message)

export type UserConflict = "DUPLICATE_EMAIL" | "LAST_OWNER"

const CONFLICT_MESSAGES: Record<UserConflict, string> = {
  DUPLICATE_EMAIL: "Another user already has this email",
  LAST_OWNER: "The organization needs at least one active owner",
}

export const conflict = (code: UserConflict) => errorResponse(409, code, CONFLICT_MESSAGES[code])
