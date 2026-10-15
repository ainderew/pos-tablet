import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { stores, users } from "@pos/db"
import { GET as GET_STORE, PATCH as PATCH_STORE } from "@/app/api/stores/[storeId]/route"
import { GET as LIST_STORES, POST as CREATE_STORE } from "@/app/api/stores/route"
import { createSession } from "@/lib/auth/session"
import { params, req, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
const as: Record<"owner" | "admin" | "manager" | "cashier" | "outsider", string> = { owner: "", admin: "", manager: "", cashier: "", outsider: "" }

beforeAll(async () => {
  s = await setupTestServer()
  const [{ org_id: otherOrg }] = await s.db.select({ org_id: stores.org_id }).from(stores).where(eq(stores.id, s.ids.foreignStore))
  const [admin] = await s.db.insert(users).values({ org_id: s.ids.org, full_name: "Ada Admin", role: "ADMIN", email: "admin@example.com" }).returning()
  const [outsider] = await s.db.insert(users).values({ org_id: otherOrg, full_name: "Otto Outsider", role: "OWNER", email: "otto@example.com" }).returning()
  const cookie = async (userId: string) => `pos_session=${(await createSession(s.db, userId)).token}`
  as.owner = await cookie(s.ids.owner)
  as.admin = await cookie(admin.id)
  as.manager = await cookie(s.ids.manager)
  // Cashiers can't sign in to the back office (auth.test.ts); a session made for one anyway gets nothing
  as.cashier = await cookie(s.ids.cashier)
  as.outsider = await cookie(outsider.id)
})
afterAll(() => s.close())

const list = (cookie: string | null, query = "") => LIST_STORES(req("GET", `/api/stores${query}`, { cookie }))
const create = (cookie: string, body: unknown, origin?: string | null) => CREATE_STORE(req("POST", "/api/stores", { cookie, body, origin }))
const get = (cookie: string, storeId: string) => GET_STORE(req("GET", `/api/stores/${storeId}`, { cookie }), params({ storeId }))
const patch = (cookie: string, storeId: string, body: unknown) => PATCH_STORE(req("PATCH", `/api/stores/${storeId}`, { cookie, body }), params({ storeId }))
const names = async (res: Response) => ((await res.json()).stores as { name: string }[]).map((x) => x.name)

describe("GET /api/stores", () => {
  it("lists the stores the caller may work in", async () => {
    expect(await names(await list(as.owner))).toEqual(["Main", "Branch"])
    expect(await names(await list(as.admin))).toEqual(["Main", "Branch"])
    expect(await names(await list(as.manager))).toEqual(["Main"])
    expect(await names(await list(as.outsider))).toEqual(["Not ours"])
    expect((await list(null)).status).toBe(401)
  })

  it("searches by name, ignoring case", async () => {
    expect(await names(await list(as.owner, "?search=bran"))).toEqual(["Branch"])
    expect(await names(await list(as.owner, "?search=%25"))).toEqual([]) // "%" is literal, not a wildcard
  })
})

describe("POST /api/stores", () => {
  it("lets owners and admins add a store with the default policies", async () => {
    const res = await create(as.owner, { name: "  Night market  ", business_name: "General Store", business_tin: "" })
    expect(res.status).toBe(201)
    const { store } = await res.json()
    expect(store).toMatchObject({
      org_id: s.ids.org,
      name: "Night market",
      business_name: "General Store",
      business_tin: null,
      business_address: null,
      receipt_header_lines: [],
      receipt_footer_lines: [],
      time_zone: "Asia/Manila",
      stock_policy: "enforce",
      offline_credit_mode: "A",
      offline_credit_cap: null,
      deleted_at: null,
    })
    expect((await create(as.admin, { name: "Kiosk" })).status).toBe(201)
    expect(await names(await list(as.outsider))).toEqual(["Not ours"])
  })

  it("refuses managers, blank names and cross-site requests", async () => {
    expect((await create(as.manager, { name: "Mine" })).status).toBe(403)
    expect((await create(as.cashier, { name: "Mine" })).status).toBe(403)
    const bad = await create(as.owner, { name: "   " })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_INPUT", issues: [{ path: "name" }] } })
    expect((await create(as.owner, { name: "X" }, null)).status).toBe(403)
  })
})

describe("GET /api/stores/:storeId", () => {
  it("returns a store in the caller's scope, 404 otherwise", async () => {
    const res = await get(as.manager, s.ids.store)
    expect(res.status).toBe(200)
    expect((await res.json()).store).toMatchObject({ id: s.ids.store, name: "Main" })
    expect((await get(as.manager, s.ids.branch)).status).toBe(404)
    expect((await get(as.owner, s.ids.branch)).status).toBe(200)
    expect((await get(as.owner, s.ids.foreignStore)).status).toBe(404)
    expect((await get(as.owner, "not-a-uuid")).status).toBe(404)
    expect((await get(as.cashier, s.ids.store)).status).toBe(403)
  })
})

describe("PATCH /api/stores/:storeId", () => {
  it("updates receipt and policy fields and bumps the version", async () => {
    const before = (await (await get(as.owner, s.ids.branch)).json()).store
    const res = await patch(as.owner, s.ids.branch, {
      business_name: "General Store Branch",
      business_address: "",
      receipt_header_lines: ["Welcome!", "Open 6am-10pm"],
      receipt_footer_lines: ["Thank you"],
      time_zone: "asia/manila",
      stock_policy: "warn",
    })
    expect(res.status).toBe(200)
    const { store } = await res.json()
    expect(store).toMatchObject({
      name: "Branch",
      business_name: "General Store Branch",
      business_address: null,
      receipt_header_lines: ["Welcome!", "Open 6am-10pm"],
      receipt_footer_lines: ["Thank you"],
      time_zone: "Asia/Manila",
      stock_policy: "warn",
    })
    expect(store.version).toBeGreaterThan(before.version)
    expect((await patch(as.admin, s.ids.branch, { time_zone: "UTC" })).status).toBe(200)
  })

  it("requires a cap for offline credit mode C, on the store as it will be", async () => {
    const noCap = await patch(as.owner, s.ids.store, { offline_credit_mode: "C" })
    expect(noCap.status).toBe(400)
    expect(await noCap.json()).toMatchObject({ error: { code: "INVALID_INPUT", issues: [{ path: "offline_credit_cap" }] } })
    const ok = await patch(as.owner, s.ids.store, { offline_credit_mode: "C", offline_credit_cap: 500 })
    expect((await ok.json()).store).toMatchObject({ offline_credit_mode: "C", offline_credit_cap: 500 })
    expect((await patch(as.owner, s.ids.store, { offline_credit_cap: null })).status).toBe(400)
    expect((await patch(as.owner, s.ids.store, { offline_credit_cap: 250.5 })).status).toBe(200)
    const back = await patch(as.owner, s.ids.store, { offline_credit_mode: "A" })
    expect((await back.json()).store).toMatchObject({ offline_credit_mode: "A" })
  })

  it("validates each field", async () => {
    for (const body of [
      { time_zone: "Mars/Olympus" },
      { time_zone: "+08:00" },
      { stock_policy: "block" },
      { offline_credit_mode: "D" },
      { offline_credit_cap: -1 },
      { receipt_header_lines: "Welcome" },
      { name: "" },
      {},
    ]) {
      const res = await patch(as.owner, s.ids.store, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe("INVALID_INPUT")
    }
  })

  it("is for owners and admins, inside their organization", async () => {
    expect((await patch(as.manager, s.ids.store, { name: "Mine now" })).status).toBe(403)
    expect((await patch(as.owner, s.ids.foreignStore, { name: "Mine now" })).status).toBe(404)
    expect((await patch(as.outsider, s.ids.store, { name: "Mine now" })).status).toBe(404)
  })
})
