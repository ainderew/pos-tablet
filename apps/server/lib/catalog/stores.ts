// Store fields the back office edits (receipt header, time zone and the policies tablets apply offline)
import { z } from "zod"
import type { stores } from "@pos/db"
import { money, optionalText, requiredText } from "./validation"
import type { Issue } from "./validation"

type StoreRow = typeof stores.$inferSelect

// Every canonical IANA name this runtime knows, plus UTC (which Intl lists separately)
const TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])

/** An IANA time zone, stored under its canonical spelling ("asia/manila" -> "Asia/Manila") */
const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((tz, ctx) => {
    let resolved: string | null = null
    try {
      resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone
    } catch {
      resolved = null
    }
    if (!resolved || !TIME_ZONES.has(resolved)) {
      ctx.addIssue({ code: "custom", message: "Unknown time zone (use an IANA name such as Asia/Manila)" })
      return z.NEVER
    }
    return resolved
  })

const receiptLines = z.array(z.string().max(200)).max(20)

const storeFields = {
  name: requiredText(120),
  business_name: optionalText(200),
  business_address: optionalText(300),
  business_tin: optionalText(40),
}

export const StoreCreateSchema = z.object({
  name: storeFields.name,
  business_name: storeFields.business_name.optional(),
  business_address: storeFields.business_address.optional(),
  business_tin: storeFields.business_tin.optional(),
})

export const StorePatchSchema = z
  .object({
    ...storeFields,
    receipt_header_lines: receiptLines,
    receipt_footer_lines: receiptLines,
    time_zone: timeZone,
    stock_policy: z.enum(["enforce", "warn"]),
    offline_credit_mode: z.enum(["A", "B", "C"]),
    offline_credit_cap: money.nullable(),
  })
  .partial()

export type StorePatch = z.infer<typeof StorePatchSchema>

/** Rules across fields, checked on the store as it will be after the change */
export function storePatchIssues(store: StoreRow, patch: StorePatch): Issue[] {
  const mode = patch.offline_credit_mode ?? store.offline_credit_mode
  const cap = patch.offline_credit_cap !== undefined ? patch.offline_credit_cap : store.offline_credit_cap
  if (mode === "C" && cap == null) {
    return [{ path: "offline_credit_cap", message: 'Required when offline_credit_mode is "C"' }]
  }
  return []
}
