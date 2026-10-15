// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LoginForm } from "@/components/auth/login-form"
import { apiError, mockApi, submit, type } from "./helpers"

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const fill = (email: string, password: string) => {
  type(screen.getByLabelText("Email"), email)
  type(screen.getByLabelText("Password"), password)
}

describe("sign-in form", () => {
  it("asks for both fields before calling the server", async () => {
    const { calls } = mockApi({})
    render(<LoginForm />)
    await submit(screen.getByRole("button", { name: "Sign in" }))
    expect(screen.getByText("Enter your email")).toBeTruthy()
    expect(screen.getByText("Enter your password")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("shows the server's answer to a wrong password and clears the password", async () => {
    mockApi({ "POST /api/auth/login": apiError(401, "INVALID_CREDENTIALS", "Wrong email or password") })
    render(<LoginForm />)
    fill("owner@example.com", "nope")
    await submit(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Wrong email or password")).toBeTruthy()
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("")
    expect(router.replace).not.toHaveBeenCalled()
  })

  it("shows the rate limit message", async () => {
    mockApi({ "POST /api/auth/login": apiError(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again in 15 minutes.") })
    render(<LoginForm />)
    fill("owner@example.com", "whatever")
    await submit(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Too many sign-in attempts. Try again in 15 minutes.")).toBeTruthy()
  })

  it("signs in and goes into the back office", async () => {
    const { calls } = mockApi({ "POST /api/auth/login": { body: { user: { id: "u1" } } } })
    render(<LoginForm />)
    fill(" owner@example.com ", "correct horse battery")
    await submit(screen.getByRole("button", { name: "Sign in" }))
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/auth/login", body: { email: "owner@example.com", password: "correct horse battery" } })
    expect(router.replace).toHaveBeenCalledWith("/stores")
  })
})
