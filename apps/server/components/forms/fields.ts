// zod building blocks for form inputs. Inputs hold strings (what was typed); the schemas check them
// the way the server will and turn them into the numbers / nulls the API expects.
import { z } from "zod"

export interface NumberRules {
  /** Most decimal places allowed: 2 for money, 3 for quantities, 0 for whole numbers */
  decimals: number
  allowNegative?: boolean
  /** Must be strictly greater than this */
  greaterThan?: number
  nonZero?: boolean
  /** Largest allowed size (either sign) */
  max?: number
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/

function decimalPlaces(raw: string): number {
  const dot = raw.indexOf(".")
  return dot < 0 ? 0 : raw.slice(dot + 1).replace(/0+$/, "").length
}

/** What's wrong with a typed number, or null when it's fine */
export function numberProblem(raw: string, rules: NumberRules): string | null {
  const value = raw.replace(/,/g, "")
  if (!NUMBER.test(value)) return "Enter a number"
  const n = Number(value)
  if (!Number.isFinite(n)) return "Enter a number"
  if (!rules.allowNegative && n < 0) return "Can't be negative"
  if (rules.greaterThan !== undefined && n <= rules.greaterThan) return `Must be more than ${rules.greaterThan}`
  if (rules.nonZero && n === 0) return "Can't be zero"
  if (rules.max !== undefined && Math.abs(n) > rules.max) return `Must be at most ${rules.max.toLocaleString("en-PH")}`
  if (decimalPlaces(value) > rules.decimals) return rules.decimals === 0 ? "Use a whole number" : `Use at most ${rules.decimals} decimals`
  return null
}

export const toNumber = (raw: string) => Number(raw.replace(/,/g, ""))

/** A required number field */
export function numberInput(requiredMessage: string, rules: NumberRules) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const problem = value ? numberProblem(value, rules) : requiredMessage
      if (problem) ctx.addIssue({ code: "custom", message: problem })
    })
    .transform(toNumber)
}

/** An optional number field: blank becomes null */
export function optionalNumberInput(rules: NumberRules) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const problem = value ? numberProblem(value, rules) : null
      if (problem) ctx.addIssue({ code: "custom", message: problem })
    })
    .transform((value) => (value ? toNumber(value) : null))
}

/** The server's limits (lib/catalog/validation.ts): nothing a store sells costs a billion pesos */
export const MAX_MONEY = 1_000_000_000
export const MAX_QUANTITY = 1_000_000_000
export const MAX_COUNT = 2_147_483_647

/** A peso amount ≥ 0 with at most 2 decimals */
export const MONEY: NumberRules = { decimals: 2, max: MAX_MONEY }
/** Whole numbers stored in integer columns (thresholds) */
export const COUNT: NumberRules = { decimals: 0, max: MAX_COUNT }

/** Required text, trimmed */
export const requiredText = (message: string, max = 200) =>
  z.string().trim().min(1, message).max(max, `At most ${max} characters`)

/** Optional text: blank becomes null */
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((value) => value || null)

export const optionalEmail = () =>
  z
    .string()
    .trim()
    .max(200, "At most 200 characters")
    .refine((value) => !value || z.email().safeParse(value).success, "Enter a valid email address")
    .transform((value) => (value ? value.toLowerCase() : null))

export const PIN_PATTERN = /^\d{4,6}$/
export const MIN_PASSWORD_LENGTH = 10

/** Text for a number input, from a stored value */
export const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value))
