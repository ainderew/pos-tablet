// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CategoriesView } from "@/components/categories/categories-view"
import { CategoryNameForm } from "@/components/categories/category-name-form"
import { apiError, chooseMenuItem, installDomShims, mockApi, submit, type, WithBackOffice } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("category name form", () => {
  it("needs a name and shows DUPLICATE_NAME under it", async () => {
    const { calls } = mockApi({ "POST /api/categories": apiError(409, "DUPLICATE_NAME", "A category with this name already exists") })
    render(<CategoryNameForm onSaved={() => {}} />)
    await submit(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("Enter a category name")).toBeTruthy()
    expect(calls).toHaveLength(0)

    type(screen.getByLabelText("New category name"), "Beverages")
    await submit(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByText("A category with this name already exists")).toBeTruthy()
    expect(calls[0].body).toEqual({ name: "Beverages" })
  })
})

describe("categories page", () => {
  it("explains CATEGORY_IN_USE and links to the products that use it", async () => {
    mockApi({
      "GET /api/categories": { body: { categories: [{ id: "c1", name: "Beverages", product_count: 2 }] } },
      "DELETE /api/categories/c1": apiError(409, "CATEGORY_IN_USE", "2 products use this category. Move or delete them first."),
    })
    render(
      <WithBackOffice>
        <CategoriesView />
      </WithBackOffice>
    )
    await chooseMenuItem(await screen.findByRole("button", { name: "Actions for Beverages" }), "Delete")
    await submit(screen.getByRole("button", { name: "Delete category" }))

    expect(await screen.findByText("Beverages is still in use")).toBeTruthy()
    expect(screen.getByText(/2 active products use it/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "See those products" }).getAttribute("href")).toBe("/stores/store-1/products?category=c1")
  })
})
