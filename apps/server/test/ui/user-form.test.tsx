// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { UserForm } from "@/components/users/user-form"
import type { ManagedUser, SessionUser, Store } from "@/lib/api-client"
import { ADMIN, apiError, chooseOption, installDomShims, MANAGER, mockApi, optionsOf, OWNER, STORE, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const BRANCH: Store = { ...STORE, id: "store-2", name: "Branch" }

function setup(actor: SessionUser, user?: ManagedUser, stores: Store[] = [STORE, BRANCH]) {
  const onSaved = vi.fn()
  render(<UserForm actor={actor} user={user} stores={stores} onSaved={onSaved} onCancel={() => {}} />)
  return { onSaved }
}

const save = (label = "Add user") => submit(screen.getByRole("button", { name: label }))

describe("user form: who may be given which role", () => {
  it("owners can give any role", async () => {
    setup(OWNER)
    expect(await optionsOf(screen.getByLabelText("Role"))).toEqual(["Owner", "Admin", "Manager", "Cashier"])
  })

  it("admins can't create owners", async () => {
    setup(ADMIN)
    expect(await optionsOf(screen.getByLabelText("Role"))).toEqual(["Admin", "Manager", "Cashier"])
  })

  it("managers only create cashiers, in their own stores", async () => {
    const { calls } = mockApi({ "POST /api/users": { status: 201, body: { user: { id: "new", full_name: "Cara" } } } })
    setup(MANAGER, undefined, [STORE])
    const role = screen.getByLabelText("Role")
    expect(role.textContent).toContain("Cashier")
    expect((role as HTMLButtonElement).disabled).toBe(true)
    // Cashiers have no back-office password
    expect(screen.queryByLabelText(/Password/)).toBeNull()
    type(screen.getByLabelText("Name"), "Cara")
    type(screen.getByLabelText("PIN"), "4321")
    await save()
    expect(calls[0].body).toEqual({ full_name: "Cara", role: "CASHIER", pin: "4321", store_ids: ["store-1"] })
  })

  it("nobody can change their own role", () => {
    setup(ADMIN, { id: ADMIN.id, full_name: ADMIN.full_name, role: "ADMIN", email: ADMIN.email, is_active: true, has_password: true, has_pin: false, store_ids: "ALL" })
    expect((screen.getByLabelText("Role") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("You can't change your own role")).toBeTruthy()
  })
})

describe("user form: fields", () => {
  it("checks PINs, passwords, the email a password needs, and stores", async () => {
    const { calls } = mockApi({})
    setup(OWNER)
    await chooseOption(screen.getByLabelText("Role"), "Manager")
    type(screen.getByLabelText("Name"), "Manny")
    type(screen.getByLabelText(/^Password/), "short")
    type(screen.getByLabelText(/^PIN/), "12a4")
    await save()
    expect(screen.getByText("Use at least 10 characters")).toBeTruthy()
    expect(screen.getByText("A PIN is 4 to 6 digits")).toBeTruthy()
    expect(screen.getByText("Choose at least one store")).toBeTruthy()

    type(screen.getByLabelText(/^Password/), "long enough password")
    await save()
    expect(screen.getByText("Add an email: it's what they sign in with")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("shows DUPLICATE_EMAIL under the email; owners and admins get no store_ids", async () => {
    const { calls } = mockApi({ "POST /api/users": apiError(409, "DUPLICATE_EMAIL", "Another user already has this email") })
    setup(OWNER)
    await chooseOption(screen.getByLabelText("Role"), "Admin")
    expect(screen.getByText("Admins work in every store.")).toBeTruthy()
    type(screen.getByLabelText("Name"), "Ada")
    type(screen.getByLabelText(/^Email/), "Ada@Example.com")
    type(screen.getByLabelText(/^Password/), "long enough password")
    await save()
    expect(await screen.findByText("Another user already has this email")).toBeTruthy()
    expect(calls[0].body).toEqual({ full_name: "Ada", role: "ADMIN", email: "ada@example.com", password: "long enough password" })
  })

  it("edits send only what changed; becoming a cashier removes the password", async () => {
    const { calls } = mockApi({ "PATCH /api/users/u9": { body: { user: { id: "u9", full_name: "Mia" } } } })
    setup(OWNER, { id: "u9", full_name: "Mia", role: "MANAGER", email: "mia@example.com", is_active: true, has_password: true, has_pin: true, store_ids: ["store-1"] })
    expect(screen.getByLabelText(/^New PIN/)).toBeTruthy()
    await chooseOption(screen.getByLabelText("Role"), "Cashier")
    await save("Save changes")
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/users/u9" })
    expect(calls[0].body).toEqual({ role: "CASHIER", password: null })
  })
})
