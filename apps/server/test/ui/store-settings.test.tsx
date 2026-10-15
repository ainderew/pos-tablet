// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { StoreSettingsForm, toLines } from "@/components/settings/store-settings-form"
import { installDomShims, mockApi, STORE, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const save = () => submit(screen.getByRole("button", { name: "Save settings" }))

describe("store settings", () => {
  it("needs a cap for offline credit mode C, and a known time zone", async () => {
    const { calls } = mockApi({})
    render(<StoreSettingsForm store={STORE} canEdit onSaved={() => {}} />)
    await submit(screen.getByRole("radio", { name: /^C ·/ }))
    type(screen.getByLabelText("Time zone"), "Manila")
    await save()
    expect(screen.getByText("Enter the most a customer may charge while offline")).toBeTruthy()
    expect(screen.getByText("Unknown time zone: use a name like Asia/Manila")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("saves receipt lines as arrays and the cap only for mode C", async () => {
    const { calls } = mockApi({ "PATCH /api/stores/store-1": (call) => ({ body: { store: { ...STORE, ...(call.body as object) } } }) })
    const onSaved = vi.fn()
    render(<StoreSettingsForm store={{ ...STORE, offline_credit_mode: "C", offline_credit_cap: 500 }} canEdit onSaved={onSaved} />)
    type(screen.getByLabelText("Header lines"), "Accreditation No. 123  \n\n")
    type(screen.getByLabelText("Time zone"), "asia/manila")
    await submit(screen.getByRole("radio", { name: /^B ·/ }))
    await submit(screen.getByRole("radio", { name: /Allow it, and flag it/ }))
    await save()
    expect(calls[0].body).toMatchObject({
      name: "Main",
      receipt_header_lines: ["Accreditation No. 123"],
      receipt_footer_lines: ["Thank you!"],
      time_zone: "Asia/Manila",
      stock_policy: "warn",
      offline_credit_mode: "B",
      offline_credit_cap: null,
      business_address: null,
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it("is read-only for managers", () => {
    render(<StoreSettingsForm store={STORE} canEdit={false} onSaved={() => {}} />)
    expect(screen.getByText("Only owners and admins can change store settings.")).toBeTruthy()
    expect((screen.getByLabelText("Store name").closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull()
  })

  it("keeps blank lines inside the receipt text but drops trailing ones", () => {
    expect(toLines("A\n\nB  \n \n")).toEqual(["A", "", "B"])
  })
})
