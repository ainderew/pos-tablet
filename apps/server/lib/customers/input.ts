// Request bodies for the customer and store-credit routes
import { roundMoney } from "@pos/core"
import { z } from "zod"

export const CREDIT_STATUSES = ["ACTIVE", "BLOCKED", "OVERDUE"] as const
/** Ways to pay off store credit (store credit itself can't pay store credit) */
export const CREDIT_PAYMENT_METHODS = ["CASH", "GCASH", "MAYA", "CARD"] as const

// numeric(14,2) holds far more, but nothing a store sells on credit comes near a billion pesos
const MAX_MONEY = 1_000_000_000

/** Trimmed text; "" or null clears it (null), omitted stays undefined (PATCH: leave as is) */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null))

const optionalEmail = z.preprocess((v) => (typeof v === "string" ? v.trim() || null : v), z.email().max(200).nullish())

/** Money rounded to centavos */
const nonNegativeMoney = z.number().min(0).max(MAX_MONEY).transform(roundMoney)

const customerFields = {
  full_name: z.string().trim().min(1).max(120),
  phone_number: optionalText(40),
  email: optionalEmail,
  address: optionalText(300),
}

export const CreateCustomerSchema = z.object({
  ...customerFields,
  credit_limit: nonNegativeMoney.optional(),
})

export const UpdateCustomerSchema = z
  .object({
    ...customerFields,
    full_name: customerFields.full_name.optional(),
    credit_limit: nonNegativeMoney.optional(),
    credit_status: z.enum(CREDIT_STATUSES).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: "Nothing to update" })

export const PaymentSchema = z.object({
  // Rounded first, so 0.004 is refused rather than recorded as a ₱0.00 payment
  amount: z
    .number()
    .max(MAX_MONEY)
    .transform(roundMoney)
    .pipe(z.number().gt(0, "Payment amount must be greater than zero")),
  payment_method: z.enum(CREDIT_PAYMENT_METHODS),
  reference_number: optionalText(100),
  notes: optionalText(500),
})

/** Same wording as POS-bir and @pos/core's buildCreditPayment, which statements and history display */
export const paymentNotes = (method: string, reference: string | null | undefined, notes: string | null | undefined) =>
  `Payment via ${method} ${reference ? "(" + reference + ")" : ""}. ${notes || ""}`
