// Who may see and manage whom (docs/api.md, "Users"). Pure rules; the routes add the database checks
// (store ids, duplicate emails, the last active owner).
import type { UserRole } from "@pos/db"
import type { AuthedUser } from "@/lib/auth/guard"

export type Actor = Pick<AuthedUser, "id" | "role" | "storeIds">
/** A user as these rules need them: store_ids are their assigned (live) stores */
export interface Subject {
  id: string
  role: UserRole
  store_ids: string[]
}

/** Owners and admins work in every store of the organization; they have no store assignments */
export const worksInEveryStore = (role: UserRole) => role === "OWNER" || role === "ADMIN"

/**
 * Owners and admins see everyone in the organization. Managers see themselves and the managers and
 * cashiers assigned to one of their stores. Anyone else is out of scope (404).
 */
export function canSee(actor: Actor, user: Subject): boolean {
  if (actor.storeIds === "ALL") return true
  if (user.id === actor.id) return true
  const own = actor.storeIds
  return !worksInEveryStore(user.role) && user.store_ids.some((id) => own.includes(id))
}

/** Owners: any role. Admins: anything but owner. Managers: cashiers only. */
export function canAssignRole(actor: Actor, role: UserRole): boolean {
  if (actor.role === "OWNER") return true
  if (actor.role === "ADMIN") return role !== "OWNER"
  if (actor.role === "MANAGER") return role === "CASHIER"
  return false
}

/** Whether the actor may change or remove someone else: managers only cashiers wholly in their stores */
export function canManage(actor: Actor, user: Subject): boolean {
  if (!canAssignRole(actor, user.role)) return false
  if (actor.role !== "MANAGER") return true
  const own = actor.storeIds
  return own !== "ALL" && user.store_ids.length > 0 && user.store_ids.every((id) => own.includes(id))
}

export const sameStores = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((id) => set.has(id))
}

/** Why the actor may not create a user with this role, or null */
export function createDenial(actor: Actor, role: UserRole): string | null {
  return canAssignRole(actor, role) ? null : `You can't create a user with the ${role} role`
}

/** Why the actor may not make this change to the user, or null */
export function updateDenial(actor: Actor, user: Subject, change: { role?: UserRole; is_active?: boolean; store_ids?: string[] }): string | null {
  const roleChanges = change.role !== undefined && change.role !== user.role
  if (user.id === actor.id) {
    if (roleChanges) return "You can't change your own role"
    if (change.is_active === false) return "You can't deactivate yourself"
    // A manager managing their own stores would be managing a manager
    if (actor.role === "MANAGER" && change.store_ids !== undefined && !sameStores(change.store_ids, user.store_ids)) {
      return "You can't change your own stores"
    }
    return null
  }
  if (!canManage(actor, user)) return "You can't manage this user"
  if (roleChanges && !canAssignRole(actor, change.role!)) return `You can't give a user the ${change.role} role`
  return null
}

/** Why the actor may not delete the user, or null */
export function deleteDenial(actor: Actor, user: Subject): string | null {
  if (user.id === actor.id) return "You can't delete yourself"
  return canManage(actor, user) ? null : "You can't manage this user"
}
