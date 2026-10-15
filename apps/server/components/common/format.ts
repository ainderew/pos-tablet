import { format, formatDistanceToNow } from "date-fns"
import type { UnitType } from "@/lib/api-client"

const PESO = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" })

/** ₱1,234.50 */
export function formatMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  return PESO.format(Number.isFinite(n) ? n : 0)
}

/** 12 pcs, 1.25 kg */
export function formatQuantity(value: number | string | null | undefined, unitType: UnitType): string {
  const n = Number(value ?? 0)
  if (unitType === "WEIGHT") return `${n.toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`
  return `${n.toLocaleString("en-PH", { maximumFractionDigits: 3 })} pcs`
}

/** +5 / −2.5 for stock movements */
export function formatDelta(value: number | string): string {
  const n = Number(value)
  const abs = Math.abs(n).toLocaleString("en-PH", { maximumFractionDigits: 3 })
  return n > 0 ? `+${abs}` : n < 0 ? `−${abs}` : "0"
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : format(date, "MMM d, yyyy h:mm a")
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : format(date, "MMM d, yyyy")
}

/** "5 minutes ago"; "Never" when there's no date */
export function formatRelative(value: string | Date | null | undefined, never = "Never"): string {
  if (!value) return never
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? never : formatDistanceToNow(date, { addSuffix: true })
}

export const ROLE_LABELS = { OWNER: "Owner", ADMIN: "Admin", MANAGER: "Manager", CASHIER: "Cashier" } as const
