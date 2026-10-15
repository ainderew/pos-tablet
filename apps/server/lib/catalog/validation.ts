// Field rules shared by the store, catalog and stock routes (and the CSV import, which validates
// rows with the same schemas as POST/PATCH)
import { isThousandths } from "@pos/core"
import { z } from "zod"
import { errorResponse } from "@/lib/http"
import { isUuid } from "@/lib/stores"

export type Issue = { path: string; message: string }

/** 400 INVALID_INPUT with issues, the same shape readJson returns for zod failures */
export const invalidInput = (issues: Issue[], message = "Some fields are invalid") => errorResponse(400, "INVALID_INPUT", message, { issues })

export const zodIssues = (error: z.ZodError): Issue[] => error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))

/** numeric(14, 2) holds far more, but nothing a store sells costs a billion pesos */
export const MAX_MONEY = 1_000_000_000
/** numeric(14, 3) for stock: keep well inside it */
export const MAX_QUANTITY = 1_000_000_000
const MAX_INT = 2_147_483_647

export const isCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
export const round2 = (n: number) => Math.round(n * 100) / 100
export const round3 = (n: number) => Math.round(n * 1000) / 1000

/** A peso amount ≥ 0 with at most 2 decimals (float noise like 0.1 + 0.2 is rounded away) */
export const money = z
  .number()
  .min(0)
  .max(MAX_MONEY)
  .refine(isCents, "At most 2 decimal places")
  .transform(round2)

/** "" means "not set" for optional values a form sends as an empty input */
const emptyToNull = (v: unknown) => (v === "" ? null : v)

/** Optional nullable money: null, "" and missing all mean "not set" */
export const optionalMoney = z.preprocess(emptyToNull, money.nullable())

/** Optional text: trimmed; "" and null clear it */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => v || null)

export const requiredText = (max: number) => z.string().trim().min(1, "Required").max(max)

export const uuid = z.string().refine(isUuid, "Must be an id")
/** An optional reference: "" and null clear it */
export const optionalUuid = z.preprocess(emptyToNull, uuid.nullable())

export const count = z.number().int().min(0).max(MAX_INT)

/** A stock quantity is whole for QUANTITY products and in grams (3 decimals) for WEIGHT products */
export function validQuantity(unitType: string, q: number): boolean {
  if (!Number.isFinite(q) || Math.abs(q) > MAX_QUANTITY) return false
  return unitType === "QUANTITY" ? Number.isInteger(q) : isThousandths(q)
}

/** Query-string flags */
export const flag = (url: URL, name: string) => {
  const v = url.searchParams.get(name)
  return v === "1" || v === "true"
}

/** Text for a case-insensitive "contains" match (ILIKE), with its wildcards escaped */
export const containsPattern = (search: string) => `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Only the keys that were given (undefined means "not in the PATCH body") */
export function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>
}
