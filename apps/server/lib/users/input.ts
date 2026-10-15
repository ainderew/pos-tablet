// Request bodies for the user routes, and the field rules that depend on the user's role
import { z } from "zod"
import { USER_ROLES } from "@pos/db"
import type { UserRole } from "@pos/db"
import { MIN_PASSWORD_LENGTH, PIN_PATTERN } from "@/lib/auth/passwords"
import { worksInEveryStore } from "./permissions"

/** Stored lowercased (sign-in matches case-insensitively); "" or null clears it */
const email = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() || null : v), z.email().max(200).nullish())
const password = z.string().min(MIN_PASSWORD_LENGTH, `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`).max(200)
const pin = z.string().regex(PIN_PATTERN, "PINs are 4 to 6 digits")

export const CreateUserSchema = z.object({
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(USER_ROLES),
  email,
  password: password.nullish(),
  pin: pin.nullish(),
  store_ids: z.array(z.string().max(64)).max(200).optional(),
})

export const UpdateUserSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(USER_ROLES).optional(),
    email,
    // null removes it
    password: password.nullish(),
    pin: pin.nullish(),
    is_active: z.boolean().optional(),
    store_ids: z.array(z.string().max(64)).max(200).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: "Nothing to update" })

export type Issue = { path: string; message: string }

/** Rules on the user as they'll be saved: only back-office roles have passwords, which need an email */
export function fieldIssues(user: { role: UserRole; email: string | null; hasPassword: boolean; storeIds?: string[] }): Issue[] {
  const issues: Issue[] = []
  if (user.hasPassword && user.role === "CASHIER") {
    issues.push({ path: "password", message: "Cashiers have no password; they sign in on the tablet with a PIN" })
  } else if (user.hasPassword && !user.email) {
    issues.push({ path: "email", message: "A user with a password needs an email to sign in with" })
  }
  if (worksInEveryStore(user.role) && user.storeIds && user.storeIds.length > 0) {
    issues.push({ path: "store_ids", message: "Owners and admins work in every store; leave store_ids out" })
  }
  return issues
}
