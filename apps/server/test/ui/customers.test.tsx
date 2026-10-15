// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { DeleteCustomerDialog } from "@/components/customers/customer-dialogs"
import { CustomerForm } from "@/components/customers/customer-form"
import { withRunningBalance } from "@/components/customers/customer-ledger-view"
import { PaymentForm } from "@/components/customers/payment-form"
import type { Customer, LedgerEntry } from "@/lib/api-client"
import { apiError, chooseOption, installDomShims, mockApi, submit, type } from "./helpers"

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CUSTOMER: Customer = {
  id: "cu1",
  store_id: "store-1",
  full_name: "Aling Nena",
  phone_number: "09171234567",
  email: null,
  address: null,
  credit_limit: 1000,
  credit_status: "BLOCKED",
  balance: 250,
}

describe("customer form", () => {
  it("checks the name, email and limit before sending", async () => {
    const { calls } = mockApi({})
    render(<CustomerForm storeId="store-1" onSaved={() => {}} onCancel={() => {}} />)
    type(screen.getByLabelText(/^Email/), "nena@")
    type(screen.getByLabelText(/^Credit limit/), "-5")
    await submit(screen.getByRole("button", { name: "Add customer" }))
    expect(screen.getByText("Enter the customer's name")).toBeTruthy()
    expect(screen.getByText("Enter a valid email address")).toBeTruthy()
    expect(screen.getByText("Can't be negative")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it("adds a customer to the store, blanks as null", async () => {
    const { calls } = mockApi({ "POST /api/stores/store-1/customers": { status: 201, body: { customer: { ...CUSTOMER, credit_status: "ACTIVE" } } } })
    const onSaved = vi.fn()
    render(<CustomerForm storeId="store-1" onSaved={onSaved} onCancel={() => {}} />)
    type(screen.getByLabelText("Name"), "Aling Nena")
    type(screen.getByLabelText(/^Credit limit/), "1,000")
    await submit(screen.getByRole("button", { name: "Add customer" }))
    expect(calls[0].body).toEqual({ full_name: "Aling Nena", phone_number: null, email: null, address: null, credit_limit: 1000 })
    expect(onSaved).toHaveBeenCalled()
  })

  it("edits status with PATCH", async () => {
    const { calls } = mockApi({ "PATCH /api/customers/cu1": { body: { customer: CUSTOMER } } })
    render(<CustomerForm storeId="store-1" customer={CUSTOMER} onSaved={() => {}} onCancel={() => {}} />)
    await chooseOption(screen.getByLabelText("Status"), "Active")
    await submit(screen.getByRole("button", { name: "Save changes" }))
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/customers/cu1", body: { credit_status: "ACTIVE", credit_limit: 1000, full_name: "Aling Nena" } })
  })
})

describe("payment form", () => {
  it("needs an amount above zero, and asks for a reference for e-wallets", async () => {
    const { calls } = mockApi({ "POST /api/customers/cu1/payments": { status: 201, body: { entry: {}, balance: 150, customer: CUSTOMER } } })
    const onRecorded = vi.fn()
    render(<PaymentForm customer={CUSTOMER} onRecorded={onRecorded} onCancel={() => {}} />)
    type(screen.getByLabelText(/^Amount paid/), "0")
    await submit(screen.getByRole("button", { name: "Record payment" }))
    expect(screen.getByText("Must be more than 0")).toBeTruthy()
    expect(screen.queryByLabelText(/^Reference number/)).toBeNull()

    await submit(screen.getByRole("radio", { name: "GCash" }))
    type(screen.getByLabelText(/^Amount paid/), "100")
    type(screen.getByLabelText(/^Reference number/), "GC-123")
    await submit(screen.getByRole("button", { name: "Record payment" }))
    expect(calls[0]).toMatchObject({ path: "/api/customers/cu1/payments", body: { amount: 100, payment_method: "GCASH", reference_number: "GC-123", notes: null } })
    expect(onRecorded).toHaveBeenCalled()
  })

  it("warns (without refusing) when the payment is more than the balance", async () => {
    mockApi({})
    render(<PaymentForm customer={CUSTOMER} onRecorded={() => {}} onCancel={() => {}} />)
    type(screen.getByLabelText(/^Amount paid/), "300")
    expect(screen.getByText(/more than the balance/)).toBeTruthy()
  })
})

describe("deleting a customer", () => {
  it("explains HAS_BALANCE", async () => {
    mockApi({ "DELETE /api/customers/cu1": apiError(409, "HAS_BALANCE", "This customer still owes ₱250.00; settle the balance before deleting them") })
    const onDeleted = vi.fn()
    render(<DeleteCustomerDialog customer={CUSTOMER} onOpenChange={() => {}} onDeleted={onDeleted} />)
    await submit(screen.getByRole("button", { name: "Delete customer" }))
    expect(await screen.findByText("The balance isn't zero")).toBeTruthy()
    expect(screen.getByText("This customer still owes ₱250.00; settle the balance before deleting them.")).toBeTruthy()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe("ledger", () => {
  it("runs the balance: charges add, payments and adjustments deduct", () => {
    const entry = (entry_type: LedgerEntry["entry_type"], amount: number) => ({ id: entry_type + amount, entry_type, amount, created_at: "", terminal_id: null, notes: null, payment_method: null, reference_number: null })
    expect(withRunningBalance([entry("CHARGE", 300), entry("PAYMENT", 100.5), entry("ADJUSTMENT", 50), entry("CHARGE", 0.1)]).map((r) => r.balance)).toEqual([300, 199.5, 149.5, 149.6])
  })
})
