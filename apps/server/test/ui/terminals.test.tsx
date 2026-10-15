// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { formatCountdown, PairingDialog } from "@/components/terminals/pairing-dialog"
import { TerminalForm } from "@/components/terminals/terminal-form"
import type { Terminal } from "@/lib/api-client"
import { apiError, installDomShims, mockApi, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const TERMINAL: Terminal = {
  id: "t1",
  store_id: "store-1",
  name: "Counter 1",
  kind: "tablet",
  ptu_number: null,
  serial_number: null,
  min: null,
  revoked_at: null,
  paired: false,
  last_seen_at: null,
}

const code = (expiresInMs: number) => ({
  code: "ABCD-EFGH",
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  qr_payload: JSON.stringify({ v: 1, server: "https://pos.techpal.store", code: "ABCD-EFGH" }),
})

describe("add terminal form", () => {
  it("needs a name; PTU, serial and MIN are optional", async () => {
    const { calls } = mockApi({ "POST /api/stores/store-1/terminals": { status: 201, body: { terminal: TERMINAL } } })
    const onCreated = vi.fn()
    render(<TerminalForm storeId="store-1" onCreated={onCreated} onCancel={() => {}} />)
    await submit(screen.getByRole("button", { name: "Add terminal" }))
    expect(screen.getByText("Give the terminal a name")).toBeTruthy()
    expect(calls).toHaveLength(0)

    type(screen.getByLabelText("Name"), "Counter 1")
    await submit(screen.getByRole("radio", { name: "PC app" }))
    type(screen.getByLabelText(/^MIN/), "MIN-0001")
    await submit(screen.getByRole("button", { name: "Add terminal" }))
    expect(calls[0].body).toEqual({ name: "Counter 1", kind: "desktop", ptu_number: null, serial_number: null, min: "MIN-0001" })
    expect(onCreated).toHaveBeenCalledWith(TERMINAL)
  })
})

describe("pairing dialog", () => {
  it("shows the code, a QR of qr_payload, the server and a countdown to expiry", async () => {
    // Fake clock (moving with real time, so the request still resolves) to fast-forward the countdown
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    mockApi({ "POST /api/terminals/t1/pairing-code": { body: code(10 * 60 * 1000) } })
    render(<PairingDialog terminal={TERMINAL} onOpenChange={() => {}} onPaired={() => {}} />)
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy()
    const qr = screen.getByRole("img", { name: "Pairing QR code for Counter 1" }) as HTMLImageElement
    expect(qr.src.startsWith("data:image/svg+xml")).toBe(true)
    expect(screen.getByText("Server: https://pos.techpal.store")).toBeTruthy()
    expect(screen.getByRole("timer").textContent).toMatch(/Expires in (10:00|9:59)/)

    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    expect(screen.getByRole("timer").textContent).toMatch(/Expires in (8:59|8:58)/)
  })

  it("says when the code has expired and offers a new one", async () => {
    mockApi({ "POST /api/terminals/t1/pairing-code": { body: code(-1000) } })
    render(<PairingDialog terminal={TERMINAL} onOpenChange={() => {}} onPaired={() => {}} />)
    expect(await screen.findByText("This code has expired")).toBeTruthy()
    expect(screen.getByRole("button", { name: "New code" })).toBeTruthy()
  })

  it("shows why a code can't be made (a decommissioned terminal)", async () => {
    mockApi({ "POST /api/terminals/t1/pairing-code": apiError(409, "TERMINAL_REVOKED", "This terminal was decommissioned") })
    render(<PairingDialog terminal={TERMINAL} onOpenChange={() => {}} onPaired={() => {}} />)
    expect(await screen.findByText("This terminal was decommissioned")).toBeTruthy()
  })

  it("formats the countdown", () => {
    expect(formatCountdown(600_000)).toBe("10:00")
    expect(formatCountdown(65_001)).toBe("1:06")
    expect(formatCountdown(-5)).toBe("0:00")
  })
})
