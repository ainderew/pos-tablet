import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { stores, userStores, users } from "@pos/db"
import type { UserRole } from "@pos/db"
import { POST as LOGIN } from "@/app/api/auth/login/route"
import { GET as ME } from "@/app/api/auth/me/route"
import { DELETE as DELETE_USER, PATCH as PATCH_USER } from "@/app/api/users/[id]/route"
import { GET as LIST_USERS, POST as CREATE_USER } from "@/app/api/users/route"
import { hashPassword, verifyPassword } from "@/lib/auth/passwords"
import { createSession } from "@/lib/auth/session"
import { resetRateLimits } from "@/lib/rate-limit"
import { params, PASSWORD, req, sessionFrom, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
let passwordHash: string
let owner: string
let foreignOrg: string

beforeAll(async () => {
  s = await setupTestServer()
  passwordHash = await hashPassword(PASSWORD)
  owner = await cookieFor(s.ids.owner)
  foreignOrg = (await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore)))[0].org_id
})
afterAll(() => s.close())
afterEach(() => resetRateLimits())

const cookieFor = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
let n = 0
/** A user straight in the database; back-office roles get an email and PASSWORD */
async function mkUser(role: UserRole, opts: { stores?: string[]; org?: string; pin?: boolean } = {}) {
  const i = ++n
  const backOffice = role !== "CASHIER"
  const [u] = await s.db
    .insert(users)
    .values({
      org_id: opts.org ?? s.ids.org,
      full_name: `${role} ${i}`,
      role,
      email: backOffice ? `${role.toLowerCase()}${i}@example.com` : null,
      password_hash: backOffice ? passwordHash : null,
      pin_hash: opts.pin ? passwordHash : null,
    })
    .returning()
  if (opts.stores?.length) await s.db.insert(userStores).values(opts.stores.map((store_id) => ({ user_id: u.id, store_id })))
  return u
}

const list = (cookie: string, query = "") => LIST_USERS(req("GET", `/api/users${query}`, { cookie }))
const create = (cookie: string, body: unknown) => CREATE_USER(req("POST", "/api/users", { cookie, body }))
const patch = (cookie: string, id: string, body: unknown) => PATCH_USER(req("PATCH", `/api/users/${id}`, { cookie, body }), params({ id }))
const remove = (cookie: string, id: string) => DELETE_USER(req("DELETE", `/api/users/${id}`, { cookie }), params({ id }))
const me = (cookie: string) => ME(req("GET", "/api/auth/me", { cookie }))
const json = async (res: Response) => (await res.json()) as Record<string, any>
const issuesOf = async (res: Response) => {
  expect(res.status).toBe(400)
  const body = await json(res)
  expect(body.error.code).toBe("INVALID_INPUT")
  return (body.error.issues as { path: string }[]).map((i) => i.path)
}
const noHashes = (text: string) => {
  expect(text).not.toMatch(/password_hash|pin_hash/)
  expect(text).not.toMatch(/\$2[aby]\$/) // bcrypt
}

describe("listing users", () => {
  it("returns the organization's users without hashes, with has_password, has_pin and store_ids", async () => {
    const cashier = await mkUser("CASHIER", { stores: [s.ids.store, s.ids.branch], pin: true })
    const foreigner = await mkUser("OWNER", { org: foreignOrg })
    const res = await list(owner)
    expect(res.status).toBe(200)
    const text = await res.text()
    noHashes(text)
    const all = JSON.parse(text).users as Record<string, any>[]
    const ids = all.map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining([s.ids.owner, s.ids.manager, s.ids.cashier, cashier.id]))
    expect(ids).not.toContain(foreigner.id)
    expect(all.find((u) => u.id === cashier.id)).toEqual({
      id: cashier.id, org_id: s.ids.org, full_name: cashier.full_name, role: "CASHIER", email: null, is_active: true,
      has_password: false, has_pin: true, store_ids: [s.ids.store, s.ids.branch].sort(),
      version: expect.any(Number), created_at: expect.any(String), updated_at: expect.any(String), deleted_at: null,
    })
    expect(all.find((u) => u.id === s.ids.owner)).toMatchObject({ store_ids: "ALL", has_password: true, has_pin: false })
    expect(all.find((u) => u.id === s.ids.manager)).toMatchObject({ store_ids: [s.ids.store] })
  })

  it("leaves deleted users out unless include_deleted=1", async () => {
    const gone = await mkUser("CASHIER")
    await s.db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, gone.id))
    const ids = async (query = "") => (await json(await list(owner, query))).users.map((u: { id: string }) => u.id)
    expect(await ids()).not.toContain(gone.id)
    expect(await ids("?include_deleted=1")).toContain(gone.id)
  })

  it("is for owners, admins and managers only", async () => {
    expect((await list("pos_session=nope")).status).toBe(401)
    expect((await list(await cookieFor(s.ids.cashier))).status).toBe(403)
    const crossSite = await CREATE_USER(req("POST", "/api/users", { cookie: owner, origin: "https://evil.example", body: { full_name: "X", role: "CASHIER" } }))
    expect(crossSite.status).toBe(403)
  })
})

describe("creating users", () => {
  it("creates a manager who can sign in with the email (case-insensitively) and password", async () => {
    const res = await create(owner, { full_name: " Mila Manager ", role: "MANAGER", email: " Mila@Example.COM ", password: "a long password", pin: "4321", store_ids: [s.ids.branch, s.ids.branch] })
    expect(res.status).toBe(201)
    const text = await res.text()
    noHashes(text)
    const { user } = JSON.parse(text)
    expect(user).toMatchObject({ full_name: "Mila Manager", role: "MANAGER", email: "mila@example.com", is_active: true, has_password: true, has_pin: true, store_ids: [s.ids.branch] })

    const [row] = await s.db.select().from(users).where(eq(users.id, user.id))
    expect(await verifyPassword("4321", row.pin_hash)).toBe(true)
    const login = await LOGIN(req("POST", "/api/auth/login", { body: { email: "MILA@example.com", password: "a long password" } }))
    expect(login.status).toBe(200)
    expect(await json(await me(sessionFrom(login)))).toMatchObject({ user: { id: user.id, store_ids: [s.ids.branch] } })
  })

  it("creates cashiers with a PIN and no password, and owners and admins without store assignments", async () => {
    const cashier = (await json(await create(owner, { full_name: "Cora", role: "CASHIER", pin: "123456", store_ids: [s.ids.store] }))).user
    expect(cashier).toMatchObject({ email: null, has_password: false, has_pin: true, store_ids: [s.ids.store] })
    const admin = (await json(await create(owner, { full_name: "Ada", role: "ADMIN", email: "ada@example.com", password: "a long password", store_ids: [] }))).user
    expect(admin).toMatchObject({ role: "ADMIN", store_ids: "ALL", has_pin: false })
    expect(await s.db.select().from(userStores).where(eq(userStores.user_id, admin.id))).toEqual([])
  })

  it("validates the fields", async () => {
    const base = { full_name: "Val", role: "MANAGER" }
    expect(await issuesOf(await create(owner, { ...base, full_name: " " }))).toEqual(["full_name"])
    expect(await issuesOf(await create(owner, { ...base, role: "SUPERUSER" }))).toEqual(["role"])
    expect(await issuesOf(await create(owner, { ...base, email: "nope" }))).toEqual(["email"])
    expect(await issuesOf(await create(owner, { ...base, email: "val@example.com", password: "short" }))).toEqual(["password"])
    for (const pin of ["123", "1234567", "12a4", 1234]) expect(await issuesOf(await create(owner, { ...base, pin }))).toEqual(["pin"])
    // Passwords are for back-office roles, and need an email to sign in with
    expect(await issuesOf(await create(owner, { full_name: "C", role: "CASHIER", email: "c@example.com", password: "a long password" }))).toEqual(["password"])
    expect(await issuesOf(await create(owner, { ...base, password: "a long password" }))).toEqual(["email"])
    // Owners and admins work in every store
    expect(await issuesOf(await create(owner, { full_name: "A", role: "ADMIN", store_ids: [s.ids.store] }))).toEqual(["store_ids"])
  })

  it("only assigns live stores of the caller's organization", async () => {
    const [closed] = await s.db.insert(stores).values({ org_id: s.ids.org, name: "Closed", deleted_at: new Date() }).returning()
    for (const store_ids of [[s.ids.foreignStore], [randomUUID()], ["not-a-uuid"], [s.ids.store, closed.id]]) {
      const res = await create(owner, { full_name: "C", role: "CASHIER", store_ids })
      expect(await issuesOf(res)).toEqual(["store_ids"])
    }
  })
})

describe("emails", () => {
  it("are unique case-insensitively, across organizations, among users that aren't deleted", async () => {
    expect((await create(owner, { full_name: "First", role: "MANAGER", email: "Dup@Example.com" })).status).toBe(201)
    const again = await create(owner, { full_name: "Second", role: "MANAGER", email: "dup@EXAMPLE.com" })
    expect(again.status).toBe(409)
    expect((await json(again)).error.code).toBe("DUPLICATE_EMAIL")

    // On edit too
    const other = await mkUser("MANAGER")
    expect((await json(await patch(owner, other.id, { email: "DUP@example.com" }))).error.code).toBe("DUPLICATE_EMAIL")
    // Keeping (or re-casing) one's own email is fine
    expect((await patch(owner, other.id, { email: other.email!.toUpperCase() })).status).toBe(200)

    // A user in another organization holds the address: sign-in is by email alone
    const foreigner = await mkUser("OWNER", { org: foreignOrg })
    expect((await create(owner, { full_name: "Copy", role: "MANAGER", email: foreigner.email })).status).toBe(409)

    // A deactivated user keeps theirs; a deleted user's can be reused
    const inactive = await mkUser("MANAGER")
    await s.db.update(users).set({ is_active: false }).where(eq(users.id, inactive.id))
    expect((await create(owner, { full_name: "Copy", role: "MANAGER", email: inactive.email })).status).toBe(409)
    expect((await remove(owner, inactive.id)).status).toBe(200)
    expect((await create(owner, { full_name: "Copy", role: "MANAGER", email: inactive.email })).status).toBe(201)
  })
})

describe("editing users", () => {
  it("updates fields and returns the user without hashes", async () => {
    const cashier = await mkUser("CASHIER", { stores: [s.ids.store] })
    const res = await patch(owner, cashier.id, { full_name: "Renamed", pin: "9876", email: "cashier.contact@example.com" })
    expect(res.status).toBe(200)
    const text = await res.text()
    noHashes(text)
    expect(JSON.parse(text).user).toMatchObject({ full_name: "Renamed", has_pin: true, has_password: false, email: "cashier.contact@example.com" })
    const [row] = await s.db.select().from(users).where(eq(users.id, cashier.id))
    expect(await verifyPassword("9876", row.pin_hash)).toBe(true)
    expect(row.version).toBeGreaterThan(cashier.version)
    // null clears a PIN
    expect((await json(await patch(owner, cashier.id, { pin: null }))).user.has_pin).toBe(false)
  })

  it("validates the fields", async () => {
    const manager = await mkUser("MANAGER")
    const cashier = await mkUser("CASHIER")
    expect(await issuesOf(await patch(owner, manager.id, {}))).toEqual([""])
    expect(await issuesOf(await patch(owner, manager.id, { is_active: "no" }))).toEqual(["is_active"])
    expect(await issuesOf(await patch(owner, manager.id, { password: "short" }))).toEqual(["password"])
    expect(await issuesOf(await patch(owner, manager.id, { pin: "12" }))).toEqual(["pin"])
    expect(await issuesOf(await patch(owner, cashier.id, { password: "a long password" }))).toEqual(["password"])
    // Removing the email of someone with a password would leave them unable to sign in
    expect(await issuesOf(await patch(owner, manager.id, { email: null }))).toEqual(["email"])
    expect(await issuesOf(await patch(owner, manager.id, { role: "ADMIN", store_ids: [s.ids.store] }))).toEqual(["store_ids"])
    expect(await issuesOf(await patch(owner, manager.id, { store_ids: [s.ids.foreignStore] }))).toEqual(["store_ids"])
  })

  it("replaces store assignments, bumping the user's version", async () => {
    const cashier = await mkUser("CASHIER", { stores: [s.ids.store] })
    const before = (await s.db.select().from(users).where(eq(users.id, cashier.id)))[0].version
    const { user } = await json(await patch(owner, cashier.id, { store_ids: [s.ids.branch] }))
    expect(user.store_ids).toEqual([s.ids.branch])
    expect(user.version).toBeGreaterThan(before)
    const rows = await s.db.select().from(userStores).where(eq(userStores.user_id, cashier.id))
    expect(rows.map((r) => r.store_id)).toEqual([s.ids.branch])
    expect((await json(await patch(owner, cashier.id, { store_ids: [] }))).user.store_ids).toEqual([])
  })

  it("drops store assignments when someone becomes an owner or admin", async () => {
    const manager = await mkUser("MANAGER", { stores: [s.ids.store] })
    const { user } = await json(await patch(owner, manager.id, { role: "ADMIN" }))
    expect(user.store_ids).toBe("ALL")
    expect(await s.db.select().from(userStores).where(eq(userStores.user_id, manager.id))).toEqual([])
  })

  it("answers 404 for users outside the organization, deleted users and bad ids", async () => {
    const foreigner = await mkUser("CASHIER", { org: foreignOrg })
    const gone = await mkUser("CASHIER")
    await s.db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, gone.id))
    for (const id of [foreigner.id, gone.id, randomUUID(), "not-a-uuid"]) {
      expect((await patch(owner, id, { full_name: "X" })).status).toBe(404)
      expect((await remove(owner, id)).status).toBe(404)
    }
    // ...and the other organization can't touch ours
    const theirOwner = await cookieFor((await mkUser("OWNER", { org: foreignOrg })).id)
    expect((await patch(theirOwner, s.ids.cashier, { full_name: "X" })).status).toBe(404)
    expect((await remove(theirOwner, s.ids.cashier)).status).toBe(404)
    expect((await json(await list(theirOwner))).users.map((u: { id: string }) => u.id)).not.toContain(s.ids.owner)
  })
})

describe("signing users out", () => {
  it("ends the sessions of a user who is deactivated", async () => {
    const manager = await mkUser("MANAGER", { stores: [s.ids.store] })
    const cookie = await cookieFor(manager.id)
    expect((await list(cookie)).status).toBe(200)
    const { user } = await json(await patch(owner, manager.id, { is_active: false }))
    expect(user.is_active).toBe(false)
    expect((await list(cookie)).status).toBe(401)
    expect((await me(cookie)).status).toBe(401)
    // Reactivated, they sign in again rather than getting the old session back
    await patch(owner, manager.id, { is_active: true })
    expect((await me(cookie)).status).toBe(401)
    expect((await LOGIN(req("POST", "/api/auth/login", { body: { email: manager.email, password: PASSWORD } }))).status).toBe(200)
  })

  it("ends the sessions of a user given a new password, which then works", async () => {
    const manager = await mkUser("MANAGER")
    const cookie = await cookieFor(manager.id)
    const res = await patch(owner, manager.id, { password: "brand new password" })
    expect(res.status).toBe(200)
    expect((await me(cookie)).status).toBe(401)
    expect((await LOGIN(req("POST", "/api/auth/login", { body: { email: manager.email, password: PASSWORD } }))).status).toBe(401)
    expect((await LOGIN(req("POST", "/api/auth/login", { body: { email: manager.email, password: "brand new password" } }))).status).toBe(200)
  })

  it("signs out a user changing their own password", async () => {
    const manager = await mkUser("MANAGER")
    const cookie = await cookieFor(manager.id)
    expect((await patch(cookie, manager.id, { password: "my own new password" })).status).toBe(200)
    expect((await me(cookie)).status).toBe(401)
  })

  it("ends the sessions of a deleted user", async () => {
    const admin = await mkUser("ADMIN")
    const cookie = await cookieFor(admin.id)
    expect((await me(cookie)).status).toBe(200)
    expect(await json(await remove(owner, admin.id))).toEqual({ ok: true })
    expect((await me(cookie)).status).toBe(401)
    const [row] = await s.db.select().from(users).where(eq(users.id, admin.id))
    expect(row).toMatchObject({ is_active: false })
    expect(row.deleted_at).toBeInstanceOf(Date)
  })

  it("removes the password and the sessions of someone demoted to cashier, or whose password is removed", async () => {
    const manager = await mkUser("MANAGER", { stores: [s.ids.store] })
    const cookie = await cookieFor(manager.id)
    const { user } = await json(await patch(owner, manager.id, { role: "CASHIER" }))
    expect(user).toMatchObject({ role: "CASHIER", has_password: false })
    expect((await me(cookie)).status).toBe(401)

    const other = await mkUser("MANAGER")
    const otherCookie = await cookieFor(other.id)
    expect((await json(await patch(owner, other.id, { password: null }))).user.has_password).toBe(false)
    expect((await me(otherCookie)).status).toBe(401)
  })

  it("keeps the sessions of a user whose name or PIN changes", async () => {
    const manager = await mkUser("MANAGER")
    const cookie = await cookieFor(manager.id)
    await patch(owner, manager.id, { full_name: "New Name", pin: "2468" })
    expect((await me(cookie)).status).toBe(200)
  })
})
