import { describe, expect, it } from "vitest"
import { GET } from "../app/api/health/route"

describe("GET /api/health", () => {
  it("reports the service as up", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, service: "pos-server" })
  })
})
