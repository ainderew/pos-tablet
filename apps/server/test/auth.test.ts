import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { pairingCodes, shiftOpens, transactions, users } from "@pos/db"
import { POST as LOGIN } from "@/app/api/auth/login/route"
import { POST as LOGOUT } from "@/app/api/auth/logout/route"
import { GET as ME } from "@/app/api/auth/me/route"
import { POST as SETUP } from "@/app/api/setup/route"
import { GET as LIST_TERMINALS, POST as CREATE_TERMINAL } from "@/app/api/stores/[storeId]/terminals/route"
import { POST as PAIRING_CODE } from "@/app/api/terminals/[terminalId]/pairing-code/route"
import { POST as UNPAIR } from "@/app/api/terminals/[terminalId]/unpair/route"
import { POST as PAIR } from "@/app/api/devices/pair/route"
import { GET as DEVICE_ME } from "@/app/api/devices/me/route"
import { resetRateLimits } from "@/lib/rate-limit"
import { params, PASSWORD, req, sessionFrom, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
beforeAll(async () => {
  s = await setupTestServer()
})
afterAll(() => s.close())
afterEach(() => resetRateLimits())

const login = async (email: string, password = PASSWORD) => LOGIN(req("POST", "/api/auth/login", { body: { email, password } }))
const sessionOf = async (email: string) => sessionFrom(await login(email))
const device = (token: string) => new Request("http://localhost/api/devices/me", { headers: { authorization: `Bearer ${token}` } })

describe("setup", () => {
  it("only works with the setup token, and only while there are no users", async () => {
    const body = { setup_token: "s3cret", organization_name: "Org", store_name: "Store", owner_name: "Me", email: "me@example.com", password: "long enough pw" }
    delete process.env.SETUP_TOKEN
    expect((await SETUP(req("POST", "/api/setup", { body }))).status).toBe(404)
    process.env.SETUP_TOKEN = "s3cret"
    expect((await SETUP(req("POST", "/api/setup", { body: { ...body, setup_token: "wrong" } }))).status).toBe(403)
    expect((await SETUP(req("POST", "/api/setup", { body: { ...body, password: "short" } }))).status).toBe(400)
    // The test database already has users
    expect((await SETUP(req("POST", "/api/setup", { body }))).status).toBe(409)
    delete process.env.SETUP_TOKEN
  })
})

describe("back-office sign-in", () => {
  it("signs in with an httpOnly, SameSite=Lax session cookie", async () => {
    const res = await login("Owner@Example.com")
    expect(res.status).toBe(200)
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const me = await ME(req("GET", "/api/auth/me", { cookie: sessionFrom(res) }))
    expect(await me.json()).toMatchObject({ user: { role: "OWNER", store_ids: "ALL" } })
  })

  it("refuses wrong passwords, unknown emails and cashiers, all with the same answer", async () => {
    for (const res of [await login("owner@example.com", "wrong"), await login("nobody@example.com"), await login("cashier@example.com")]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } })
    }
  })

  it("rate-limits guessing after 5 attempts per account", async () => {
    for (let i = 0; i < 5; i++) expect((await login("owner@example.com", "nope")).status).toBe(401)
    expect((await login("owner@example.com", PASSWORD)).status).toBe(429)
  })

  it("ends the session at logout and when the user is deactivated", async () => {
    const cookie = await sessionOf("manager@example.com")
    expect((await ME(req("GET", "/api/auth/me", { cookie }))).status).toBe(200)
    expect((await LOGOUT(req("POST", "/api/auth/logout", { cookie }))).status).toBe(200)
    expect((await ME(req("GET", "/api/auth/me", { cookie }))).status).toBe(401)

    const again = await sessionOf("manager@example.com")
    await s.db.update(users).set({ is_active: false }).where(eq(users.id, s.ids.manager))
    expect((await ME(req("GET", "/api/auth/me", { cookie: again }))).status).toBe(401)
    await s.db.update(users).set({ is_active: true }).where(eq(users.id, s.ids.manager))
  })
})

describe("guard", () => {
  it("refuses state changes without a same-site Origin (CSRF)", async () => {
    const cookie = await sessionOf("owner@example.com")
    const create = (origin: string | null) =>
      CREATE_TERMINAL(req("POST", `/api/stores/${s.ids.store}/terminals`, { cookie, origin, body: { name: "T" } }), params({ storeId: s.ids.store }))
    expect((await create(null)).status).toBe(403)
    expect((await create("https://evil.example")).status).toBe(403)
    expect((await create("http://localhost")).status).toBe(201)
  })

  it("keeps managers to their stores and everyone to their organization", async () => {
    const manager = await sessionOf("manager@example.com")
    const owner = await sessionOf("owner@example.com")
    const list = (cookie: string, storeId: string) => LIST_TERMINALS(req("GET", `/api/stores/${storeId}/terminals`, { cookie }), params({ storeId }))
    expect((await list(manager, s.ids.store)).status).toBe(200)
    expect((await list(manager, s.ids.branch)).status).toBe(404)
    expect((await list(owner, s.ids.branch)).status).toBe(200)
    expect((await list(owner, s.ids.foreignStore)).status).toBe(404)
    expect((await list(owner, "not-a-uuid")).status).toBe(404)
  })
})

describe("device pairing", () => {
  const newTerminal = async (cookie: string) => {
    const res = await CREATE_TERMINAL(req("POST", `/api/stores/${s.ids.store}/terminals`, { cookie, body: { name: "Counter tablet", ptu_number: "FP-1" } }), params({ storeId: s.ids.store }))
    return (await res.json()).terminal as { id: string }
  }
  const codeFor = async (cookie: string, terminalId: string) => {
    const res = await PAIRING_CODE(req("POST", `/api/terminals/${terminalId}/pairing-code`, { cookie }), params({ terminalId }))
    return res.json() as Promise<{ code: string; qr_payload: string }>
  }
  const pair = (code: string) => PAIR(req("POST", "/api/devices/pair", { origin: null, body: { code, device_info: { model: "Tab A9" } } }))

  it("pairs a device once per code and authenticates it by bearer token", async () => {
    const cookie = await sessionOf("manager@example.com")
    const terminal = await newTerminal(cookie)
    const { code, qr_payload } = await codeFor(cookie, terminal.id)
    expect(JSON.parse(qr_payload)).toMatchObject({ v: 1, code })

    const typed = code.toLowerCase().replace("-", " ") // as someone might type it
    const res = await pair(typed)
    expect(res.status).toBe(201)
    const paired = await res.json()
    expect(paired).toMatchObject({ terminal: { id: terminal.id, ptu_number: "FP-1" }, store: { id: s.ids.store, stock_policy: "enforce" } })
    expect(paired.token).toMatch(/^pdt_/)
    expect(paired.resume).toMatchObject({ last_device_seq: 0, last_invoice_number: 0, last_credit_note_number: 0, last_z_reading: null })

    expect((await pair(code)).status).toBe(400) // single use
    expect((await DEVICE_ME(device(paired.token))).status).toBe(200)
    expect((await DEVICE_ME(device("pdt_forged"))).status).toBe(401)
  })

  it("refuses expired codes, and only the newest code works", async () => {
    const cookie = await sessionOf("manager@example.com")
    const terminal = await newTerminal(cookie)
    const first = await codeFor(cookie, terminal.id)
    const second = await codeFor(cookie, terminal.id)
    expect((await pair(first.code)).status).toBe(400)
    await s.db.update(pairingCodes).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(pairingCodes.terminal_id, terminal.id))
    expect((await pair(second.code)).status).toBe(400)
  })

  it("re-pairing moves the terminal to the new device and resumes its numbering", async () => {
    const cookie = await sessionOf("manager@example.com")
    const terminal = await newTerminal(cookie)
    const oldDevice = (await (await pair((await codeFor(cookie, terminal.id)).code)).json()).token

    // The old device synced a shift and sale SI-000007 before it broke
    const shiftId = randomUUID()
    await s.db.insert(shiftOpens).values({ id: shiftId, store_id: s.ids.store, terminal_id: terminal.id, device_seq: 41, created_at: new Date(), user_id: s.ids.cashier, opening_fund: 0, snapshot_z_counter: 0, snapshot_accumulated_total: 0 })
    await s.db.insert(transactions).values({
      id: randomUUID(), store_id: s.ids.store, terminal_id: terminal.id, device_seq: 42, created_at: new Date(), shift_id: shiftId,
      invoice_number: "SI-000007", transaction_type: "SALE", status: "PAID", gross_sales: 10, vatable_sales: 8.93, vat_amount: 1.07,
      vat_exempt_sales: 0, zero_rated_sales: 0, total_discount: 0, net_sales: 10, pax_count: 1, senior_count: 0, payment_method: "CASH", change_amount: 0,
    })

    const replacement = await (await pair((await codeFor(cookie, terminal.id)).code)).json()
    expect(replacement.resume).toMatchObject({ last_device_seq: 42, last_invoice_number: 7, last_credit_note_number: 0 })
    expect((await DEVICE_ME(device(oldDevice))).status).toBe(401) // one device per terminal
    expect((await DEVICE_ME(device(replacement.token))).status).toBe(200)

    const res = await UNPAIR(req("POST", `/api/terminals/${terminal.id}/unpair`, { cookie }), params({ terminalId: terminal.id }))
    expect(await res.json()).toEqual({ revoked: 1 })
    expect((await DEVICE_ME(device(replacement.token))).status).toBe(401)
  })

  it("lists each terminal's own pairing status and last-seen time", async () => {
    const cookie = await sessionOf("manager@example.com")
    const paired = await newTerminal(cookie)
    const unpaired = await newTerminal(cookie)
    const token = (await (await pair((await codeFor(cookie, paired.id)).code)).json()).token
    await DEVICE_ME(device(token))
    const res = await LIST_TERMINALS(req("GET", `/api/stores/${s.ids.store}/terminals`, { cookie }), params({ storeId: s.ids.store }))
    const list = (await res.json()).terminals as { id: string; paired: boolean; last_seen_at: string | null }[]
    expect(list.find((t) => t.id === paired.id)).toMatchObject({ paired: true, last_seen_at: expect.anything() })
    expect(list.find((t) => t.id === unpaired.id)).toMatchObject({ paired: false, last_seen_at: null })
  })

  it("rate-limits pairing attempts per address", async () => {
    for (let i = 0; i < 10; i++) expect((await pair("WRONG-CODE")).status).toBe(400)
    expect((await pair("WRONG-CODE")).status).toBe(429)
  })
})
