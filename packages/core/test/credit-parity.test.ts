// Golden parity: fixtures/pc-payment-parity.json records POS-bir's real POST /api/customers/payment.
// buildCreditPayment must write the same PAYMENT entry, balance and CASH_IN, except where POS-bir
// was wrong (listed in INTENDED_DIFFERENCES).
import { describe, expect, it } from "vitest"
import { buildCreditPayment, CashMovementRecordSchema, CreditLedgerEntryRecordSchema, roundMoney } from "../src"
import type { CreditPaymentErrorCode } from "../src"
import fixtures from "./fixtures/pc-payment-parity.json"

type Row = Record<string, any>
interface Scenario {
  name: string
  customerBefore: { balance: number; limit: number; status: string } | null
  request: Row
  status: number
  response: Row
  customerAfter: Row | null
  ledger: Row[]
  cashMovements: Row[]
}

const PC_ERRORS: [RegExp, CreditPaymentErrorCode][] = [
  [/Missing required fields/, "MISSING_FIELDS"],
  [/Customer not found/, "CUSTOMER_NOT_FOUND"],
]

const INTENDED_DIFFERENCES: Record<string, string> = {
  rounding_residue: "POS-bir left 20.200000000000003; balances are rounded to centavos",
  negative_amount: "POS-bir accepted -50 and increased the debt; amounts must be > 0",
}

const scenarios = (fixtures as unknown as { scenarios: Scenario[] }).scenarios

describe(`buildCreditPayment matches POS-bir (${(fixtures as any).generatedFrom})`, () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (name, s) => {
    let n = 0
    const result = buildCreditPayment(
      {
        customerId: s.request.customerId,
        amount: s.request.amount,
        paymentMethod: s.request.paymentMethod,
        reference: s.request.reference,
        notes: s.request.notes,
      },
      {
        customer: s.customerBefore
          ? { id: "rosa", full_name: "Aling Rosa", current_debt_balance: s.customerBefore.balance }
          : null,
      },
      {
        storeId: "store-1",
        terminalId: "terminal-1",
        shiftId: s.request.shiftId ?? null,
        userId: "user-1",
        now: new Date("2026-10-15T03:00:00.000Z"),
        newId: () => `pay-id-${++n}`,
      }
    )

    if (name === "negative_amount") {
      expect(result).toMatchObject({ ok: false, code: "INVALID_AMOUNT" })
      return
    }
    if (s.status !== 200) {
      const code = PC_ERRORS.find(([re]) => re.test(s.response.error))?.[1]
      expect(code, `unmapped POS-bir error: ${s.response.error}`).toBeDefined()
      expect(result).toMatchObject({ ok: false, code })
      return
    }
    if (!result.ok) throw new Error(`expected a payment, got ${result.code}`)

    const pcEntry = s.ledger[0]
    const pcBalance = name in INTENDED_DIFFERENCES ? roundMoney(s.customerAfter!.current_debt_balance) : s.customerAfter!.current_debt_balance
    expect(result.customerBalanceAfter).toBe(pcBalance)
    expect(result.ledgerEntry).toMatchObject({
      customer_id: pcEntry.customer_id,
      shift_id: pcEntry.shift_id,
      entry_type: "PAYMENT",
      amount: pcEntry.amount,
      running_balance: pcBalance,
      notes: pcEntry.notes,
      payment_method: s.request.paymentMethod,
      reference_number: s.request.reference ?? null,
    })
    CreditLedgerEntryRecordSchema.parse(result.ledgerEntry)

    expect(result.cashMovement ? [result.cashMovement] : []).toEqual(
      s.cashMovements.map((m) => expect.objectContaining({ shift_id: m.shift_id, type: m.type, amount: m.amount, reason: m.reason }))
    )
    if (result.cashMovement) CashMovementRecordSchema.parse(result.cashMovement)
  })

  it("refuses paying store credit with store credit, and non-numeric amounts", () => {
    const ctx = { storeId: "s", terminalId: "t", shiftId: null, userId: null, now: new Date(), newId: () => "x" }
    const customer = { id: "rosa", full_name: "Aling Rosa", current_debt_balance: 100 }
    expect(buildCreditPayment({ customerId: "rosa", amount: 10, paymentMethod: "STORE_CREDIT" }, { customer }, ctx)).toMatchObject({
      ok: false,
      code: "INVALID_PAYMENT_METHOD",
    })
    expect(buildCreditPayment({ customerId: "rosa", amount: "abc", paymentMethod: "CASH" }, { customer }, ctx)).toMatchObject({
      ok: false,
      code: "INVALID_AMOUNT",
    })
  })
})
