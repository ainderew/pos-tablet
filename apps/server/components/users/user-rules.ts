// Who may manage whom (docs/api.md, "Users"), as the back office uses it to offer only what the
// server will accept. The server stays the judge (it also knows a cashier's stores outside a
// manager's view).
import type { ManagedUser, SessionUser, UserRole } from "@/lib/api-client"

export const ROLE_ORDER: readonly UserRole[] = ["OWNER", "ADMIN", "MANAGER", "CASHIER"]

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  OWNER: "Everything, in every store, including other owners",
  ADMIN: "Everything in every store except managing owners",
  MANAGER: "Runs their stores: catalog, stock, customers, terminals and cashiers",
  CASHIER: "Sells on the tablet with a PIN; no back office",
}

/** Owners and admins work in every store and have no store assignments */
export const worksInEveryStore = (role: UserRole) => role === "OWNER" || role === "ADMIN"

/** Roles the signed-in user may give: owners any, admins anything but owner, managers cashier */
export function assignableRoles(actor: Pick<SessionUser, "role">): UserRole[] {
  if (actor.role === "OWNER") return [...ROLE_ORDER]
  if (actor.role === "ADMIN") return ["ADMIN", "MANAGER", "CASHIER"]
  if (actor.role === "MANAGER") return ["CASHIER"]
  return []
}

/** Whether the signed-in user may change or deactivate someone else */
export function canManage(actor: Pick<SessionUser, "id" | "role">, user: Pick<ManagedUser, "id" | "role">): boolean {
  if (actor.id === user.id) return false
  return assignableRoles(actor).includes(user.role)
}
