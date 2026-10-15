import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "../app/api/health/route"
import { setDb } from "@/lib/db"
import { setupTestServer } from "./helpers"

let s: Awaited<ReturnType<typeof setupTestServer>>
beforeAll(async () => {
  s = await setupTestServer()
})
afterAll(() => s.close())

describe("GET /api/health", () => {
  it("reports the service and its database as up", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, service: "pos-server", database: "up" })
  })

  it("answers 503 when the database is unreachable", async () => {
    setDb({ execute: () => Promise.reject(new Error("connection refused")) } as never)
    const res = await GET()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, database: "down" })
    setDb(s.db)
  })
})
