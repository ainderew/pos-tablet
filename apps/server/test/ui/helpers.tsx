// Helpers for the back-office component tests (jsdom): a fake fetch that answers like the API, the
// browser APIs Radix needs that jsdom lacks, and a way to pick from a Radix Select.
import { act, fireEvent, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { vi } from "vitest"
import { BackOfficeContext } from "@/components/back-office/back-office-context"
import type { BackOfficeContextValue } from "@/components/back-office/back-office-context"
import type { SessionUser, Store } from "@/lib/api-client"

export interface Call {
  method: string
  url: string
  path: string
  query: URLSearchParams
  body: unknown
}

type Reply = { status?: number; body?: unknown } | ((call: Call) => { status?: number; body?: unknown })

/**
 * Replaces global fetch. Routes are "METHOD /path" (exact path, query ignored); unmatched requests
 * fail the test loudly. Returns the calls made, with JSON bodies parsed.
 */
export function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const parsed = new URL(url, "http://localhost")
    const method = (init.method ?? "GET").toUpperCase()
    let body: unknown = init.body
    if (typeof init.body === "string") body = JSON.parse(init.body)
    const call: Call = { method, url, path: parsed.pathname, query: parsed.searchParams, body }
    calls.push(call)
    const reply = routes[`${method} ${parsed.pathname}`]
    if (!reply) throw new Error(`Unexpected request: ${method} ${url}`)
    const { status = 200, body: payload } = typeof reply === "function" ? reply(call) : reply
    return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { calls, fetchMock, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) }
}

export const apiError = (status: number, code: string, message: string, issues?: { path: string; message: string }[]) => ({
  status,
  body: { error: { code, message, ...(issues ? { issues } : {}) } },
})

/** What jsdom doesn't implement but Radix (Select, Checkbox, Dialog) calls */
export function installDomShims() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  // Assigned, not vi.stubGlobal: the tests' unstubAllGlobals (for fetch) must not remove it
  if (!("ResizeObserver" in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}

/** Open a Radix Select (found by its accessible name) and pick an option */
export async function chooseOption(trigger: HTMLElement, option: string) {
  await act(async () => {
    fireEvent.click(trigger)
  })
  if (!screen.queryByRole("listbox")) {
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
    })
  }
  const listbox = await screen.findByRole("listbox")
  await act(async () => {
    fireEvent.click(within(listbox).getByRole("option", { name: option }))
  })
}

/** The options of a Radix Select, without picking one */
export async function optionsOf(trigger: HTMLElement): Promise<string[]> {
  await act(async () => {
    fireEvent.click(trigger)
  })
  if (!screen.queryByRole("listbox")) {
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
    })
  }
  const listbox = await screen.findByRole("listbox")
  const names = within(listbox)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "")
  await act(async () => {
    fireEvent.keyDown(listbox, { key: "Escape" })
  })
  return names
}

/** Open a Radix DropdownMenu and choose an item */
export async function chooseMenuItem(trigger: HTMLElement, item: string) {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" })
  })
  const menuItem = await screen.findByRole("menuitem", { name: item })
  await act(async () => {
    fireEvent.click(menuItem)
  })
}

export const OWNER: SessionUser = { id: "u-owner", org_id: "org", full_name: "Olivia Owner", role: "OWNER", email: "owner@example.com" }
export const ADMIN: SessionUser = { id: "u-admin", org_id: "org", full_name: "Ada Admin", role: "ADMIN", email: "admin@example.com" }
export const MANAGER: SessionUser = { id: "u-manager", org_id: "org", full_name: "Manny Manager", role: "MANAGER", email: "manager@example.com" }

export const STORE: Store = {
  id: "store-1",
  name: "Main",
  business_name: "General Store",
  business_address: null,
  business_tin: null,
  receipt_header_lines: [],
  receipt_footer_lines: ["Thank you!"],
  time_zone: "Asia/Manila",
  stock_policy: "enforce",
  offline_credit_mode: "A",
  offline_credit_cap: null,
}

/** Renders children inside the shell's context, as the back-office layout would */
export function WithBackOffice({ children, user = OWNER, stores = [STORE] }: { children: ReactNode; user?: SessionUser; stores?: Store[] }) {
  const value: BackOfficeContextValue = {
    user,
    stores,
    storesError: null,
    reloadStores: () => {},
    upsertStore: () => {},
    currentStoreId: stores[0]?.id ?? null,
    currentStore: stores[0] ?? null,
    rememberStore: () => {},
  }
  return <BackOfficeContext.Provider value={value}>{children}</BackOfficeContext.Provider>
}

/** Type into an input the way a person would (replacing what's there) */
export function type(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } })
}

export async function submit(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
  })
}
