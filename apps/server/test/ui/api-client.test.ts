// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ApiError, buildUrl, errorMessage, onUnauthorized } from "@/lib/api-client"
import { apiError, mockApi } from "./helpers"

afterEach(() => vi.unstubAllGlobals())

describe("api client", () => {
  it("returns the JSON body of a success", async () => {
    mockApi({ "GET /api/stores": { body: { stores: [{ id: "s1" }] } } })
    expect(await api.get("/api/stores")).toEqual({ stores: [{ id: "s1" }] })
  })

  it("surfaces { error: { code, message, issues } } as an ApiError with the server's message", async () => {
    mockApi({ "POST /api/products": apiError(400, "INVALID_INPUT", "Some fields are invalid", [{ path: "selling_price", message: "Too small" }]) })
    const error = await api.post("/api/products", { name: "x" }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: "INVALID_INPUT", message: "Some fields are invalid", issues: [{ path: "selling_price", message: "Too small" }] })
    expect(errorMessage(error)).toBe("Some fields are invalid: Too small")
  })

  it("keeps conflict codes so pages can explain them", async () => {
    mockApi({ "DELETE /api/categories/c1": apiError(409, "CATEGORY_IN_USE", "2 products use this category. Move or delete them first.") })
    const error = await api.delete("/api/categories/c1").catch((e) => e)
    expect(error).toMatchObject({ status: 409, code: "CATEGORY_IN_USE", message: "2 products use this category. Move or delete them first." })
  })

  it("gives a readable message when the error body isn't the API's (a proxy page)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })))
    const error = await api.get("/api/stores").catch((e) => e)
    expect(error).toMatchObject({ status: 502, code: "HTTP_502", message: "The server had a problem. Try again in a moment." })
  })

  it("turns a network failure into NETWORK_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))))
    const error = await api.get("/api/stores").catch((e) => e)
    expect(error).toMatchObject({ code: "NETWORK_ERROR", message: "Can't reach the server. Check your connection and try again." })
  })

  it("calls the sign-in handler on 401 UNAUTHORIZED only (not on wrong credentials)", async () => {
    const handler = vi.fn()
    const off = onUnauthorized(handler)
    mockApi({ "POST /api/auth/login": apiError(401, "INVALID_CREDENTIALS", "Wrong email or password"), "GET /api/users": apiError(401, "UNAUTHORIZED", "Sign in to continue") })
    await api.post("/api/auth/login", {}).catch(() => {})
    expect(handler).not.toHaveBeenCalled()
    await api.get("/api/users").catch(() => {})
    expect(handler).toHaveBeenCalledTimes(1)
    off()
  })

  it("sends JSON with a content type, FormData as-is, and leaves empty query values out", async () => {
    const { calls, fetchMock } = mockApi({ "PATCH /api/products/p1": { body: { product: {} } }, "POST /api/products/import": { body: { created: 1 } } })
    await api.patch("/api/products/p1", { name: "Rice" })
    const form = new FormData()
    form.append("file", new Blob(["name"]), "a.csv")
    await api.post("/api/products/import", form, { query: { store_id: "s1" } })
    const [, jsonInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((jsonInit.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect(calls[0].body).toEqual({ name: "Rice" })
    const [url, formInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe("/api/products/import?store_id=s1")
    expect(formInit.body).toBe(form)
    expect((formInit.headers as Record<string, string>)["content-type"]).toBeUndefined()
    expect(buildUrl("/api/products", { search: "", category_id: undefined, store_id: "s1" })).toBe("/api/products?store_id=s1")
  })
})
