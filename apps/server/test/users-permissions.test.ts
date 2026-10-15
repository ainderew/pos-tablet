// docs/api.md "Who may manage whom": owners anyone, admins anyone but owners, managers only cashiers
// wholly in their own stores; nobody changes their own role or removes themselves; the last active
// owner stays
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { organizations, stores, userStores, users } from "@pos/db"
import type { Db, UserRole } from "@pos/db"
import { DELETE as DELETE_USER, PATCH as PATCH_USER } from "@/app/api/users/[id]/route"
import { GET as LIST_USERS, POST as CREATE_USER } from "@/app/api/users/route"
import { hashPassword } from "@/lib/auth/passwords"
import { createSession } from "@/lib/auth/session"
import { anotherActiveOwner } from "@/lib/users/checks"
import { params, PASSWORD, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let passwordHash: string
const cookies = {} as Record<"OWNER" | "ADMIN" | "MANAGER", string>
let adminId: string

beforeAll(async () => {
  s = await setupTestServer()
  passwordHash = await hashPassword(PASSWORD)
  adminId = (await mkUser("ADMIN")).id
  cookies.OWNER = await cookieFor(s.ids.owner)
  cookies.ADMIN = await cookieFor(adminId)
  cookies.MANAGER = await cookieFor(s.ids.manager) // works in Main only
})
afterAll(() => s.close())

const cookieFor = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
let n = 0
async function mkUser(role: UserRole, opts: { stores?: string[]; org?: string } = {}) {
  const i = ++n
  const backOffice = role !== "CASHIER"
  const [u] = await s.db
    .insert(users)
    .values({ org_id: opts.org ?? s.ids.org, full_name: `${role} ${i}`, role, email: backOffice ? `p${role.toLowerCase()}${i}@example.com` : null, password_hash: backOffice ? passwordHash : null })
    .returning()
  if (opts.stores?.length) await s.db.insert(userStores).values(opts.stores.map((store_id) => ({ user_id: u.id, store_id })))
  return u
}

const list = (cookie: string) => LIST_USERS(req("GET", "/api/users", { cookie }))
const create = (cookie: string, body: unknown) => CREATE_USER(req("POST", "/api/users", { cookie, body }))
const patch = (cookie: string, id: string, body: unknown) => PATCH_USER(req("PATCH", `/api/users/${id}`, { cookie, body }), params({ id }))
const remove = (cookie: string, id: string) => DELETE_USER(req("DELETE", `/api/users/${id}`, { cookie }), params({ id }))
const json = async (res: Response) => (await res.json()) as Record<string, any>
const roleOf = async (id: string) => (await s.db.select().from(users).where(eq(users.id, id)))[0]

// Kinds of target, relative to the manager (who works in Main)
const TARGETS = {
  owner: () => mkUser("OWNER"),
  admin: () => mkUser("ADMIN"),
  "manager in Main": () => mkUser("MANAGER", { stores: [s.ids.store] }),
  "manager in Branch": () => mkUser("MANAGER", { stores: [s.ids.branch] }),
  "cashier in Main": () => mkUser("CASHIER", { stores: [s.ids.store] }),
  "cashier in Branch": () => mkUser("CASHIER", { stores: [s.ids.branch] }),
  "cashier in Main and Branch": () => mkUser("CASHIER", { stores: [s.ids.store, s.ids.branch] }),
  "cashier without a store": () => mkUser("CASHIER"),
}
type Target = keyof typeof TARGETS

// 200 allowed, 403 visible but not allowed, 404 out of scope
const MATRIX: Record<keyof typeof cookies, Record<Target, number>> = {
  OWNER: { owner: 200, admin: 200, "manager in Main": 200, "manager in Branch": 200, "cashier in Main": 200, "cashier in Branch": 200, "cashier in Main and Branch": 200, "cashier without a store": 200 },
  ADMIN: { owner: 403, admin: 200, "manager in Main": 200, "manager in Branch": 200, "cashier in Main": 200, "cashier in Branch": 200, "cashier in Main and Branch": 200, "cashier without a store": 200 },
  MANAGER: { owner: 404, admin: 404, "manager in Main": 403, "manager in Branch": 404, "cashier in Main": 200, "cashier in Branch": 404, "cashier in Main and Branch": 403, "cashier without a store": 404 },
}

describe("who may manage whom", () => {
  for (const actor of ["OWNER", "ADMIN", "MANAGER"] as const) {
    it(`${actor}: edits, deactivates and deletes exactly the users the rules allow`, async () => {
      for (const [target, expected] of Object.entries(MATRIX[actor]) as [Target, number][]) {
        const edited = await TARGETS[target]()
        expect((await patch(cookies[actor], edited.id, { full_name: "Changed" })).status, `${actor} edits ${target}`).toBe(expected)
        expect((await patch(cookies[actor], edited.id, { pin: "1111" })).status, `${actor} sets the PIN of ${target}`).toBe(expected)
        expect((await patch(cookies[actor], edited.id, { is_active: false })).status, `${actor} deactivates ${target}`).toBe(expected)
        const deleted = await TARGETS[target]()
        expect((await remove(cookies[actor], deleted.id)).status, `${actor} deletes ${target}`).toBe(expected)
        expect((await roleOf(deleted.id)).deleted_at === null, `${target} still there`).toBe(expected !== 200)
        if (expected === 403) expect((await json(await remove(cookies[actor], deleted.id))).error.code).toBe("FORBIDDEN")
      }
    })
  }

  it("managers see themselves and the managers and cashiers of their stores, with only their stores", async () => {
    const visible = { managerMain: await TARGETS["manager in Main"](), cashierMain: await TARGETS["cashier in Main"](), both: await TARGETS["cashier in Main and Branch"]() }
    const hidden = [await TARGETS.owner(), await TARGETS.admin(), await TARGETS["manager in Branch"](), await TARGETS["cashier in Branch"](), await TARGETS["cashier without a store"]()]
    const users = (await json(await list(cookies.MANAGER))).users as { id: string; store_ids: string[] }[]
    const ids = users.map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining([s.ids.manager, ...Object.values(visible).map((u) => u.id)]))
    for (const u of [...hidden, { id: s.ids.owner }, { id: adminId }, { id: s.ids.cashier }]) expect(ids).not.toContain(u.id)
    expect(users.find((u) => u.id === visible.both.id)!.store_ids).toEqual([s.ids.store])
    // Owners and admins see everyone
    for (const actor of ["OWNER", "ADMIN"] as const) {
      const all = (await json(await list(cookies[actor]))).users.map((u: { id: string }) => u.id)
      expect(all).toEqual(expect.arrayContaining([...hidden.map((u) => u.id), visible.both.id, s.ids.owner]))
    }
  })
})

describe("roles", () => {
  it("owners create and promote to any role", async () => {
    expect((await create(cookies.OWNER, { full_name: "Co-owner", role: "OWNER", email: "co-owner@example.com", password: "a long password" })).status).toBe(201)
    const manager = await mkUser("MANAGER")
    expect((await json(await patch(cookies.OWNER, manager.id, { role: "OWNER" }))).user.role).toBe("OWNER")
  })

  it("admins can't create owners or make anyone an owner, but can manage the other roles", async () => {
    for (const role of ["OWNER"]) expect((await create(cookies.ADMIN, { full_name: "X", role })).status).toBe(403)
    for (const role of ["ADMIN", "MANAGER", "CASHIER"]) expect((await create(cookies.ADMIN, { full_name: "X", role })).status).toBe(201)
    const manager = await mkUser("MANAGER")
    expect((await patch(cookies.ADMIN, manager.id, { role: "OWNER" })).status).toBe(403)
    expect((await patch(cookies.ADMIN, manager.id, { role: "ADMIN" })).status).toBe(200)
    expect((await patch(cookies.ADMIN, manager.id, { role: "CASHIER" })).status).toBe(200)
    expect((await roleOf(manager.id)).role).toBe("CASHIER")
  })

  it("managers create only cashiers, only in their own stores", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) expect((await create(cookies.MANAGER, { full_name: "X", role })).status).toBe(403)
    // Without store_ids, the cashier works in the manager's stores
    const res = await create(cookies.MANAGER, { full_name: "New cashier", role: "CASHIER", pin: "1234" })
    expect(res.status).toBe(201)
    expect((await json(res)).user).toMatchObject({ role: "CASHIER", store_ids: [s.ids.store], has_pin: true })
    expect((await create(cookies.MANAGER, { full_name: "X", role: "CASHIER", store_ids: [s.ids.store] })).status).toBe(201)
    for (const store_ids of [[s.ids.branch], [s.ids.store, s.ids.branch], []]) {
      const refused = await create(cookies.MANAGER, { full_name: "X", role: "CASHIER", store_ids })
      expect(refused.status, JSON.stringify(store_ids)).toBe(400)
      expect((await json(refused)).error.issues.map((i: { path: string }) => i.path)).toEqual(["store_ids"])
    }
  })

  it("managers can't promote cashiers or move them out of their stores", async () => {
    const cashier = await mkUser("CASHIER", { stores: [s.ids.store] })
    for (const role of ["MANAGER", "ADMIN", "OWNER"]) expect((await patch(cookies.MANAGER, cashier.id, { role })).status).toBe(403)
    expect((await patch(cookies.MANAGER, cashier.id, { role: "CASHIER" })).status).toBe(200) // no change
    expect((await patch(cookies.MANAGER, cashier.id, { store_ids: [s.ids.branch] })).status).toBe(400)
    expect((await patch(cookies.MANAGER, cashier.id, { store_ids: [] })).status).toBe(400)
    expect((await patch(cookies.MANAGER, cashier.id, { password: "a long password" })).status).toBe(400)

    // A manager of both stores may move a cashier between them
    const twoStores = await mkUser("MANAGER", { stores: [s.ids.store, s.ids.branch] })
    const cookie = await cookieFor(twoStores.id)
    expect((await json(await patch(cookie, cashier.id, { store_ids: [s.ids.branch] }))).user.store_ids).toEqual([s.ids.branch])
    // ...after which the Main-only manager no longer sees the cashier
    expect((await patch(cookies.MANAGER, cashier.id, { full_name: "X" })).status).toBe(404)
  })
})

describe("self-protection", () => {
  for (const actor of ["OWNER", "ADMIN", "MANAGER"] as const) {
    it(`${actor}: can edit their own profile but not their role, activity or existence`, async () => {
      const self = actor === "OWNER" ? s.ids.owner : actor === "ADMIN" ? adminId : s.ids.manager
      const other: UserRole = actor === "MANAGER" ? "CASHIER" : "MANAGER"
      const refused = await patch(cookies[actor], self, { role: other })
      expect(refused.status).toBe(403)
      expect((await json(refused)).error).toMatchObject({ code: "FORBIDDEN", message: "You can't change your own role" })
      expect((await patch(cookies[actor], self, { is_active: false })).status).toBe(403)
      expect((await remove(cookies[actor], self)).status).toBe(403)
      expect((await patch(cookies[actor], self, { role: actor, is_active: true })).status).toBe(200) // not a change
      expect((await patch(cookies[actor], self, { full_name: `Renamed ${actor}`, pin: "5555" })).status).toBe(200)
      const row = await roleOf(self)
      expect(row).toMatchObject({ role: actor, is_active: true, deleted_at: null, full_name: `Renamed ${actor}` })
    })
  }

  it("a manager can't change their own stores", async () => {
    expect((await patch(cookies.MANAGER, s.ids.manager, { store_ids: [s.ids.store, s.ids.branch] })).status).toBe(403)
    expect((await patch(cookies.MANAGER, s.ids.manager, { store_ids: [] })).status).toBe(403)
    expect((await patch(cookies.MANAGER, s.ids.manager, { store_ids: [s.ids.store] })).status).toBe(200) // unchanged
  })
})

describe("the last active owner", () => {
  /** An organization of its own, so other tests' owners don't count */
  async function orgWithOwners(count: number) {
    const [org] = await s.db.insert(organizations).values({ name: "Owners Inc" }).returning()
    await s.db.insert(stores).values({ org_id: org.id, name: "Only store" })
    const owners = []
    for (let i = 0; i < count; i++) owners.push(await mkUser("OWNER", { org: org.id }))
    return { org: org.id, owners }
  }

  it("counts only active, not deleted owners", async () => {
    const { org, owners } = await orgWithOwners(2)
    const db = s.db as Db
    expect(await db.transaction((tx) => anotherActiveOwner(tx, org, owners[0].id))).toBe(true)
    await s.db.update(users).set({ is_active: false }).where(eq(users.id, owners[1].id))
    expect(await db.transaction((tx) => anotherActiveOwner(tx, org, owners[0].id))).toBe(false)
    await s.db.update(users).set({ is_active: true, deleted_at: new Date() }).where(eq(users.id, owners[1].id))
    expect(await db.transaction((tx) => anotherActiveOwner(tx, org, owners[0].id))).toBe(false)
  })

  it("one of two owners may demote, deactivate or delete the other, but never themselves", async () => {
    const { owners } = await orgWithOwners(3)
    const [a, b, c] = owners
    const cookie = await cookieFor(a.id)
    expect((await patch(cookie, b.id, { role: "ADMIN" })).status).toBe(200)
    expect((await patch(cookie, c.id, { is_active: false })).status).toBe(200)
    expect((await remove(cookie, c.id)).status).toBe(200) // an inactive owner can go
    // a is now the only active owner and can't remove themselves
    expect((await patch(cookie, a.id, { role: "ADMIN" })).status).toBe(403)
    expect((await remove(cookie, a.id)).status).toBe(403)
  })

  it("can't be demoted by an owner who was demoted while their request ran", async () => {
    const { owners } = await orgWithOwners(2)
    const [a, b] = owners
    const [cookieA, cookieB] = [await cookieFor(a.id), await cookieFor(b.id)]
    // a's request hashes a password first (slow), so b's demotion of a lands in between
    const [fromA, fromB] = await Promise.all([
      patch(cookieA, b.id, { role: "MANAGER", password: "a long password" }),
      patch(cookieB, a.id, { role: "MANAGER" }),
    ])
    expect(fromB.status).toBe(200)
    expect(fromA.status).toBe(409)
    expect((await json(fromA)).error.code).toBe("LAST_OWNER")
    expect(await roleOf(b.id)).toMatchObject({ role: "OWNER", is_active: true })
  })

  it("survives two owners removing each other at the same time", async () => {
    for (const change of [{ role: "MANAGER" }, { is_active: false }]) {
      const { org, owners } = await orgWithOwners(2)
      const [a, b] = owners
      const results = await Promise.all([patch(await cookieFor(a.id), b.id, change), patch(await cookieFor(b.id), a.id, change)])
      expect(results.map((r) => r.status).filter((st) => st === 200)).toHaveLength(1)
      const remaining = await s.db.select().from(users).where(eq(users.org_id, org))
      expect(remaining.filter((u) => u.role === "OWNER" && u.is_active && !u.deleted_at)).toHaveLength(1)
    }
  })
})
