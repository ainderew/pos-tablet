// Regression tests for the security review's findings
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { buildSale, buildShiftOpen, SYNC_PROTOCOL_VERSION, terminalCounters } from "@pos/core"
import type { Product, PushRecord } from "@pos/core"
import { products, shiftOpens, transactions } from "@pos/db"
import nextConfig from "../next.config"
import { POST as LOGIN } from "@/app/api/auth/login/route"
import { GET as ME } from "@/app/api/auth/me/route"
import { POST as PAIR } from "@/app/api/devices/pair/route"
import { POST as SETUP } from "@/app/api/setup/route"
import { POST as CREATE_TERMINAL } from "@/app/api/stores/[storeId]/terminals/route"
import { POST as PUSH } from "@/app/api/sync/v1/push/route"
import { POST as PAIRING_CODE } from "@/app/api/terminals/[terminalId]/pairing-code/route"
import { csvField, parseCsv } from "@/lib/catalog/csv"
import { rateLimit, rateLimitKeyCount, resetRateLimits } from "@/lib/rate-limit"
import { params, PASSWORD, req, sessionFrom, setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
beforeAll(async () => {
  s = await setupTestServer()
})
afterAll(() => s.close())
afterEach(() => resetRateLimits())

const login = (email: string, password = PASSWORD, init: { ip?: string; origin?: string | null } = {}) =>
  LOGIN(req("POST", "/api/auth/login", { body: { email, password }, origin: init.origin, headers: init.ip ? { "x-real-ip": init.ip } : {} }))

describe("login", () => {
  it("refuses a cross-site sign-in (login CSRF) and sets no cookie", async () => {
    const res = await login("owner@example.com", PASSWORD, { origin: "https://evil.example" })
    expect(res.status).toBe(403)
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("refuses oversized bodies before parsing them", async () => {
    const res = await LOGIN(req("POST", "/api/auth/login", { body: { email: "a@b.c", password: "x".repeat(10_000) } }))
    expect(res.status).toBe(413)
  })

  it("limits each address before reading the body, even with a new email every time", async () => {
    for (let i = 0; i < 30; i++) expect((await login(`flood${i}@example.com`, "x", { ip: "203.0.113.9" })).status).toBe(401)
    expect((await login("owner@example.com", PASSWORD, { ip: "203.0.113.9" })).status).toBe(429)
    expect((await login("owner@example.com", PASSWORD, { ip: "198.51.100.1" })).status).toBe(200)
  })

  it("limits guesses per account across addresses, and a success clears the per-address count", async () => {
    for (let i = 0; i < 4; i++) expect((await login("manager@example.com", "wrong", { ip: "192.0.2.1" })).status).toBe(401)
    expect((await login("manager@example.com", PASSWORD, { ip: "192.0.2.1" })).status).toBe(200) // resets this address
    for (let i = 0; i < 4; i++) expect((await login("manager@example.com", "wrong", { ip: "192.0.2.1" })).status).toBe(401)
    // 50 failures from many addresses lock the account everywhere for the window
    for (let i = 0; i < 50 - 8; i++) await login("manager@example.com", "wrong", { ip: `10.0.${Math.floor(i / 4)}.${i % 4}` })
    expect((await login("manager@example.com", PASSWORD, { ip: "192.0.2.200" })).status).toBe(429)
  })

  it("keeps the cookie for the 30-day maximum (the server slides the real expiry)", async () => {
    const res = await login("owner@example.com")
    const expires = /Expires=([^;]+)/i.exec(res.headers.get("set-cookie")!)![1]
    const days = (new Date(expires).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29)
    expect(days).toBeLessThanOrEqual(30)
  })

  it("treats a malformed session cookie as signed out, not a server error", async () => {
    expect((await ME(req("GET", "/api/auth/me", { cookie: "pos_session=%E0%A4%A" }))).status).toBe(401)
  })
})

describe("rate limiter", () => {
  it("sweeps expired windows and refuses new keys rather than grow without bound", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 50_000; i++) rateLimit(`k${i}`, 5, 60_000, t0)
    expect(rateLimit("one-more", 5, 60_000, t0)).toBe(false)
    expect(rateLimitKeyCount()).toBe(50_000)
    // Once the windows expire they're swept out and new keys work again
    expect(rateLimit("later", 5, 60_000, t0 + 120_000)).toBe(true)
    expect(rateLimitKeyCount()).toBe(1)
  })
})

describe("setup", () => {
  it("refuses a cross-site setup", async () => {
    process.env.SETUP_TOKEN = "t0ken"
    const body = { setup_token: "t0ken", organization_name: "O", store_name: "S", owner_name: "N", email: "n@example.com", password: "long enough pw" }
    expect((await SETUP(req("POST", "/api/setup", { body, origin: "https://evil.example" }))).status).toBe(403)
    delete process.env.SETUP_TOKEN
  })
})

describe("device pairing and push limits", () => {
  let token: string
  let terminalId: string
  beforeAll(async () => {
    const cookie = sessionFrom(await login("owner@example.com"))
    const { terminal } = await (await CREATE_TERMINAL(req("POST", `/api/stores/${s.ids.store}/terminals`, { cookie, body: { name: "T" } }), params({ storeId: s.ids.store }))).json()
    terminalId = terminal.id
    const code = async () => (await (await PAIRING_CODE(req("POST", `/api/terminals/${terminal.id}/pairing-code`, { cookie }), params({ terminalId: terminal.id }))).json()).code
    const pair = (c: string, device_info?: unknown) => PAIR(req("POST", "/api/devices/pair", { origin: null, body: { code: c, device_info } }))

    // Oversized device_info is a 400, and the code stays usable
    const first = await code()
    expect((await pair(first, { blob: "x".repeat(5000) })).status).toBe(400)
    // Big invoice numbers from a long-running terminal don't break the resume point (bigint)
    const shiftId = randomUUID()
    await s.db.insert(shiftOpens).values({ id: shiftId, store_id: s.ids.store, terminal_id: terminal.id, device_seq: 1, created_at: new Date(), user_id: s.ids.cashier, opening_fund: 0, snapshot_z_counter: 0, snapshot_accumulated_total: 0 })
    await s.db.insert(transactions).values({
      id: randomUUID(), store_id: s.ids.store, terminal_id: terminal.id, device_seq: 2, created_at: new Date(), shift_id: shiftId,
      invoice_number: "SI-12345678901", transaction_type: "SALE", status: "PAID", gross_sales: 1, vatable_sales: 0.89, vat_amount: 0.11,
      vat_exempt_sales: 0, zero_rated_sales: 0, total_discount: 0, net_sales: 1, pax_count: 1, senior_count: 0, payment_method: "CASH", change_amount: 0,
    })
    const paired = await pair(first, { model: "Tab" })
    expect(paired.status).toBe(201)
    const body = await paired.json()
    expect(body.resume).toMatchObject({ last_device_seq: 2, last_invoice_number: 12345678901 })
    token = body.token
  })

  const push = async (records: unknown[]) => {
    const res = await PUSH(new Request("http://localhost/api/sync/v1/push", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, records }) }))
    return { status: res.status, body: await res.json() }
  }

  const records = async () => {
    const [p] = await s.db.insert(products).values({ org_id: s.ids.org, name: "Soap", selling_price: 25, cost_price: 18, unit_type: "QUANTITY" }).returning()
    const product = { ...p, stock_level: 10, pos_id: "x", is_synced: true } as unknown as Product
    let seq = 100
    const ctx = { storeId: s.ids.store, terminalId, now: new Date(), newId: () => randomUUID(), nextSeq: () => ++seq, userId: s.ids.cashier, cashierId: s.ids.cashier }
    const opened = buildShiftOpen({ openingFund: 0 }, { user: { id: s.ids.cashier, is_active: true }, openShift: null, counters: terminalCounters(null, 0) }, ctx)
    if (!opened.ok) throw new Error(opened.code)
    const sale = buildSale(
      { lines: [{ productId: product.id, quantity: 1 }], paxCount: 1, seniorCount: 1, scPwd: { idNumber: "SC-123-456", name: "Lola" } },
      { products: new Map([[product.id, product]]), openShift: opened.shift },
      { ...ctx, nextInvoiceNumber: 1 }
    )
    if (!sale.ok) throw new Error(sale.code)
    return [{ type: "shift_open", data: opened.shift }, { type: "transaction", data: sale.transaction }] as PushRecord[]
  }

  it("accepts a real SC/PWD sale (its SC/PWD ID isn't a record id)", async () => {
    expect((await push(await records())).status).toBe(200)
  })

  it.each([
    ["an id that isn't a UUID", (r: PushRecord[]) => [{ ...r[0], data: { ...r[0].data, id: "not-a-uuid" } }]],
    ["a device_seq beyond 32 bits", (r: PushRecord[]) => [{ ...r[0], data: { ...r[0].data, device_seq: 2 ** 40 } }]],
    ["money with 3 decimals", (r: PushRecord[]) => [{ ...r[0], data: { ...r[0].data, opening_fund: 0.001 } }]],
    ["an oversized text field", (r: PushRecord[]) => [r[0], { ...r[1], data: { ...r[1].data, sc_pwd_name: "x".repeat(3000) } }]],
  ])("refuses %s with a 400 before writing anything", async (_name, mutate) => {
    const res = await push(mutate(await records()))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("INVALID_INPUT")
  })
})

describe("CSV export", () => {
  it("defuses spreadsheet formulas and the import restores the text", () => {
    for (const evil of ["=HYPERLINK(\"http://x\",\"y\")", "+1+1", "@SUM(A1)", "-cmd|' /C calc'!A0"]) {
      const cell = csvField(evil)
      expect(cell.replace(/^"/, "")).toMatch(/^'/)
      expect(parseCsv(`name\n${cell}`)[1].fields[0]).toBe(evil)
    }
    expect(csvField(-12.5)).toBe("-12.5") // plain negative numbers stay numbers
    expect(csvField("Soap")).toBe("Soap")
  })
})

describe("security headers", () => {
  it("forbids framing and MIME sniffing on every page", async () => {
    const rules = await nextConfig.headers!()
    const headers = Object.fromEntries(rules.find((r) => r.source === "/:path*")!.headers.map((h) => [h.key, h.value]))
    expect(headers["X-Frame-Options"]).toBe("DENY")
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
