// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ProductForm } from "@/components/products/product-form"
import type { Category, Product } from "@/lib/api-client"
import { apiError, chooseOption, installDomShims, mockApi, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const categories: Category[] = [
  { id: "c-bev", name: "Beverages" },
  { id: "c-can", name: "Canned goods" },
]
const store = { id: "store-1", name: "Main" }

const PRODUCT: Product = {
  id: "p1",
  category_id: "c-bev",
  name: "Cola 1.5L",
  barcode: "4800000000011",
  selling_price: 75,
  cost_price: 60,
  unit_type: "QUANTITY",
  tax_category: "VATABLE",
  supplier_type: "WHOLESALER",
  wholesale_price: 70,
  wholesale_threshold: 12,
  low_stock_threshold: 5,
  notify_low_stock: true,
  is_promo: false,
  promo_price: null,
}

function setup(product?: Product) {
  const onSaved = vi.fn()
  render(<ProductForm product={product} categories={categories} store={store} onSaved={onSaved} onCancel={() => {}} />)
  return { onSaved }
}

const save = (label = "Add product") => submit(screen.getByRole("button", { name: label }))
const field = (label: RegExp | string) => screen.getByLabelText(label)

describe("product form", () => {
  it("requires a name and both prices, and checks money like the server (≥ 0, 2 decimals)", async () => {
    const { calls } = mockApi({})
    setup()
    await save()
    expect(screen.getByText("Enter the product name")).toBeTruthy()
    expect(screen.getByText("Enter the cost price")).toBeTruthy()
    expect(screen.getByText("Enter the selling price")).toBeTruthy()

    type(field("Product name"), "Rice")
    type(field(/^Cost price/), "-1")
    type(field(/^Selling price/), "10.555")
    await save()
    expect(screen.getByText("Can't be negative")).toBeTruthy()
    expect(screen.getByText("Use at most 2 decimals")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("wants the wholesale price and minimum quantity together, the minimum a whole number", async () => {
    mockApi({})
    setup()
    type(field("Product name"), "Rice")
    type(field(/^Cost price/), "40")
    type(field(/^Selling price/), "50")
    type(field(/^Wholesale price/), "45")
    await save()
    expect(screen.getByText("Set the minimum quantity too, or clear the wholesale price")).toBeTruthy()

    type(field(/^Minimum quantity/), "2.5")
    await save()
    expect(screen.getByText("Use a whole number")).toBeTruthy()

    type(field(/^Wholesale price/), "0")
    type(field(/^Minimum quantity/), "10")
    await save()
    expect(screen.getByText("Must be more than 0")).toBeTruthy()
  })

  it("needs a promo price when the product is on promo", async () => {
    mockApi({})
    setup()
    type(field("Product name"), "Rice")
    type(field(/^Cost price/), "40")
    type(field(/^Selling price/), "50")
    await submit(screen.getByRole("switch", { name: "On promo" }))
    await save()
    expect(screen.getByText("Enter the promo price")).toBeTruthy()
  })

  it("shows DUPLICATE_BARCODE under the barcode, and server field issues under their fields", async () => {
    let attempt = 0
    mockApi({
      "POST /api/products": () =>
        ++attempt === 1
          ? apiError(409, "DUPLICATE_BARCODE", "Another product already uses this barcode")
          : apiError(400, "INVALID_INPUT", "Some fields are invalid", [{ path: "category_id", message: "Category not found" }]),
    })
    setup()
    type(field("Product name"), "Rice")
    type(field(/^Barcode/), "123")
    type(field(/^Cost price/), "40")
    type(field(/^Selling price/), "50")
    await save()
    expect(await screen.findByText("Another product already uses this barcode")).toBeTruthy()
    await save()
    expect(await screen.findByText("Category not found")).toBeTruthy()
  })

  it("sends numbers and nulls the API expects, then records the opening stock at the store", async () => {
    const { calls } = mockApi({
      "POST /api/products": (call) => ({ status: 201, body: { product: { ...PRODUCT, ...(call.body as object), id: "new-id" } } }),
      "POST /api/stores/store-1/stock-movements": { status: 201, body: { movement: {}, stock_level: 25 } },
    })
    const { onSaved } = setup()
    type(field("Product name"), "  Rice 1kg ")
    await chooseOption(field("Category"), "Canned goods")
    await chooseOption(field("Sold"), "By weight (kg)")
    type(field(/^Cost price/), "40")
    type(field(/^Selling price/), "1,050.50")
    type(field(/^Opening stock at Main/), "25")
    await save()

    expect(calls[0].body).toEqual({
      name: "Rice 1kg",
      barcode: null,
      category_id: "c-can",
      unit_type: "WEIGHT",
      tax_category: "VATABLE",
      supplier_type: "WHOLESALER",
      cost_price: 40,
      selling_price: 1050.5,
      low_stock_threshold: 0,
      notify_low_stock: false,
      wholesale_threshold: 0,
      wholesale_price: null,
      is_promo: false,
      promo_price: null,
    })
    expect(calls[1]).toMatchObject({ path: "/api/stores/store-1/stock-movements", body: { product_id: "new-id", quantity_delta: 25, reason: "RESTOCK", note: "Opening stock" } })
    expect(onSaved).toHaveBeenCalled()
  })

  it("edits with PATCH; clearing wholesale pricing sends threshold 0 and no price", async () => {
    const { calls } = mockApi({ "PATCH /api/products/p1": (call) => ({ body: { product: { ...PRODUCT, ...(call.body as object) } } }) })
    setup(PRODUCT)
    expect((field(/^Wholesale price/) as HTMLInputElement).value).toBe("70")
    expect(screen.queryByLabelText(/^Opening stock/)).toBeNull()
    type(field(/^Wholesale price/), "")
    type(field(/^Minimum quantity/), "")
    await save("Save changes")
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/products/p1", body: { wholesale_price: null, wholesale_threshold: 0, category_id: "c-bev", low_stock_threshold: 5 } })
  })
})
