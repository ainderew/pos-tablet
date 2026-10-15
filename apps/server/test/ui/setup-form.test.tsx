// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SetupForm } from "@/components/auth/setup-form"
import { apiError, mockApi, submit, type } from "./helpers"

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fillValid() {
  type(screen.getByLabelText("Setup token"), "s3cret")
  type(screen.getByLabelText("Business name"), "General Store")
  type(screen.getByLabelText("First store"), "Main")
  type(screen.getByLabelText("Your name"), "Olivia")
  type(screen.getByLabelText("Email"), "Owner@Example.com")
  type(screen.getByLabelText("Password"), "correct horse battery")
  type(screen.getByLabelText("Confirm password"), "correct horse battery")
}

const button = () => screen.getByRole("button", { name: "Set up the back office" })

describe("first-time setup form", () => {
  it("checks the fields the way the server does before sending anything", async () => {
    const { calls } = mockApi({})
    render(<SetupForm />)
    fillValid()
    type(screen.getByLabelText("Email"), "not-an-email")
    type(screen.getByLabelText("Password"), "short")
    type(screen.getByLabelText("Confirm password"), "different")
    type(screen.getByLabelText(/PIN/), "12")
    await submit(button())
    expect(screen.getByText("Enter a valid email address")).toBeTruthy()
    expect(screen.getByText("Use at least 10 characters")).toBeTruthy()
    expect(screen.getByText("The passwords don't match")).toBeTruthy()
    expect(screen.getByText("A PIN is 4 to 6 digits")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("explains when the server is already set up", async () => {
    mockApi({ "POST /api/setup": apiError(409, "ALREADY_SET_UP", "Setup has already been done") })
    render(<SetupForm />)
    fillValid()
    await submit(button())
    expect(await screen.findByText("This server is already set up")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login")
  })

  it("puts a wrong setup token on its field", async () => {
    mockApi({ "POST /api/setup": apiError(403, "FORBIDDEN", "Wrong setup token") })
    render(<SetupForm />)
    fillValid()
    await submit(button())
    expect(await screen.findByText("That setup token is wrong")).toBeTruthy()
  })

  it("sets up, then signs in as the new owner", async () => {
    const { calls } = mockApi({
      "POST /api/setup": { status: 201, body: { organization_id: "o", store_id: "s", owner_id: "u" } },
      "POST /api/auth/login": { body: { user: { id: "u" } } },
    })
    render(<SetupForm />)
    fillValid()
    await submit(button())
    expect(calls[0].body).toEqual({
      setup_token: "s3cret",
      organization_name: "General Store",
      store_name: "Main",
      owner_name: "Olivia",
      email: "Owner@Example.com",
      password: "correct horse battery",
    })
    expect(calls[1]).toMatchObject({ path: "/api/auth/login", body: { email: "Owner@Example.com", password: "correct horse battery" } })
    expect(router.replace).toHaveBeenCalledWith("/stores")
  })
})
