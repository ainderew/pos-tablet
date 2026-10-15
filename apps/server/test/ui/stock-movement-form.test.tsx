// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { StockMovementForm } from "@/components/products/stock-movement-form"
import { installDomShims, mockApi, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PATH = "/api/stores/store-1/stock-movements"

function setup(unit_type: "QUANTITY" | "WEIGHT", currentLevel = 10) {
  const onRecorded = vi.fn()
  render(<StockMovementForm product={{ id: "p1", name: "Rice", unit_type }} storeId="store-1" currentLevel={currentLevel} onRecorded={onRecorded} />)
  return { onRecorded }
}

describe("restock / adjust form", () => {
  it("refuses zero, fractions of a piece and negative restocks before calling the server", async () => {
    const { calls } = mockApi({})
    setup("QUANTITY")
    const quantity = screen.getByLabelText(/^Quantity received/)
    const button = screen.getByRole("button", { name: "Record restock" })

    await submit(button)
    expect(screen.getByText("Enter how much you received")).toBeTruthy()
    type(quantity, "0")
    await submit(button)
    expect(screen.getByText("Can't be zero")).toBeTruthy()
    type(quantity, "1.5")
    await submit(button)
    expect(screen.getByText("Sold by the piece: use a whole number")).toBeTruthy()
    type(quantity, "-3")
    await submit(button)
    expect(screen.getByText("A restock adds stock. To remove stock, use Adjust.")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("allows up to 3 decimals (grams) for weighed products", async () => {
    mockApi({})
    setup("WEIGHT")
    type(screen.getByLabelText(/^Quantity received/), "1.2345")
    await submit(screen.getByRole("button", { name: "Record restock" }))
    expect(screen.getByText("Use at most 3 decimals")).toBeTruthy()
  })

  it("records an adjustment that removes stock, showing the level it will leave", async () => {
    const { calls } = mockApi({ [`POST ${PATH}`]: { status: 201, body: { movement: { id: "m1" }, stock_level: 8 } } })
    const { onRecorded } = setup("QUANTITY", 10)
    await submit(screen.getByRole("radio", { name: "Adjust" }))
    type(screen.getByLabelText(/^Change/), "-2")
    type(screen.getByLabelText(/^Note/), "Two damaged")
    expect(screen.getByText("8 pcs")).toBeTruthy()
    await submit(screen.getByRole("button", { name: "Record adjustment" }))
    expect(calls[0]).toMatchObject({ method: "POST", path: PATH, body: { product_id: "p1", quantity_delta: -2, reason: "ADJUSTMENT", note: "Two damaged" } })
    expect(onRecorded).toHaveBeenCalledWith({ movement: { id: "m1" }, stock_level: 8 })
  })

  it("shows the server's issue under the quantity", async () => {
    mockApi({ [`POST ${PATH}`]: { status: 400, body: { error: { code: "INVALID_INPUT", message: "Some fields are invalid", issues: [{ path: "quantity_delta", message: "Must be a whole number for a QUANTITY product" }] } } } })
    setup("WEIGHT")
    type(screen.getByLabelText(/^Quantity received/), "2")
    await submit(screen.getByRole("button", { name: "Record restock" }))
    expect(await screen.findByText("Must be a whole number for a QUANTITY product")).toBeTruthy()
  })
})
