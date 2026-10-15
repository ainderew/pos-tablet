"use client"

import { useMemo } from "react"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2, Lock, Receipt, Save, Store as StoreIcon, Wallet, Warehouse } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { OptionCards } from "@/components/common/option-cards"
import { FormError, FormField } from "@/components/forms/form-field"
import { MONEY, numberProblem, numberText, optionalText, requiredText, toNumber } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { OfflineCreditMode, StockPolicy, Store } from "@/lib/api-client"

const MAX_RECEIPT_LINES = 20
const MAX_LINE_LENGTH = 200
/** Characters per line on 58 mm and 80 mm paper (docs/architecture.md, "Hardware") */
const NARROW_PAPER = 32
const WIDE_PAPER = 48

export const STOCK_POLICIES: readonly { value: StockPolicy; title: string; description: string }[] = [
  {
    value: "enforce",
    title: "Refuse the sale",
    description: "A terminal won't sell more than the stock it knows about, as in the PC app.",
  },
  {
    value: "warn",
    title: "Allow it, and flag it",
    description:
      "The sale goes through and the back office gets a negative-stock warning. Suits stores whose restocks are entered here and may not have reached the tablet yet.",
  },
]

export const CREDIT_MODES: readonly { value: OfflineCreditMode; title: string; description: string }[] = [
  {
    value: "A",
    title: "A · Allow, up to the available credit (recommended for one terminal)",
    description:
      "Offline, a terminal allows credit up to what the customer had available at its last sync, minus its own sales not yet uploaded. Exact with one terminal per store; with more, a customer who goes over the limit is flagged here after the sync.",
  },
  {
    value: "B",
    title: "B · Don't allow store credit offline",
    description: "Strict: no credit sales while a terminal is offline, so customers can't buy on credit during an outage.",
  },
  {
    value: "C",
    title: "C · Allow up to a fixed amount per customer",
    description: "A middle ground for stores with several terminals: offline, each customer can charge at most the amount below.",
  },
]

const TIME_ZONES: string[] = (() => {
  try {
    return [...Intl.supportedValuesOf("timeZone"), "UTC"]
  } catch {
    return ["Asia/Manila", "UTC"]
  }
})()

/** The canonical IANA name the runtime knows for what was typed, or null (the server's rule) */
export function resolveTimeZone(value: string): string | null {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
    return TIME_ZONES.includes(resolved) ? resolved : null
  } catch {
    return null
  }
}

/** Textarea text as receipt lines: trailing spaces and trailing blank lines dropped */
export function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}

const receiptLines = z
  .string()
  .transform(toLines)
  .superRefine((lines, ctx) => {
    if (lines.length > MAX_RECEIPT_LINES) ctx.addIssue({ code: "custom", message: `At most ${MAX_RECEIPT_LINES} lines` })
    const long = lines.findIndex((l) => l.length > MAX_LINE_LENGTH)
    if (long >= 0) ctx.addIssue({ code: "custom", message: `Line ${long + 1} is longer than ${MAX_LINE_LENGTH} characters` })
  })

// The server's store rules (lib/catalog/stores.ts); offline_credit_cap is required for mode C
const schema = z
  .object({
    name: requiredText("Enter the store's name", 120),
    business_name: optionalText(200),
    business_address: optionalText(300),
    business_tin: optionalText(40),
    receipt_header_lines: receiptLines,
    receipt_footer_lines: receiptLines,
    time_zone: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        if (!value) ctx.addIssue({ code: "custom", message: "Enter a time zone, e.g. Asia/Manila" })
        else if (!resolveTimeZone(value)) ctx.addIssue({ code: "custom", message: "Unknown time zone: use a name like Asia/Manila" })
      })
      // Saved under its canonical spelling, as the server does ("asia/manila" -> "Asia/Manila")
      .transform((value) => resolveTimeZone(value) ?? value),
    stock_policy: z.enum(["enforce", "warn"]),
    offline_credit_mode: z.enum(["A", "B", "C"]),
    offline_credit_cap: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.offline_credit_mode !== "C") return
    const problem = v.offline_credit_cap ? numberProblem(v.offline_credit_cap, MONEY) : "Enter the most a customer may charge while offline"
    if (problem) ctx.addIssue({ code: "custom", path: ["offline_credit_cap"], message: problem })
  })
  .transform(({ offline_credit_cap, ...v }) => ({ ...v, offline_credit_cap: v.offline_credit_mode === "C" ? toNumber(offline_credit_cap) : null }))

type Input = z.input<typeof schema>
type Output = z.output<typeof schema>
const FIELDS = [
  "name",
  "business_name",
  "business_address",
  "business_tin",
  "receipt_header_lines",
  "receipt_footer_lines",
  "time_zone",
  "stock_policy",
  "offline_credit_mode",
  "offline_credit_cap",
] as const

function defaults(store: Store): Input {
  return {
    name: store.name,
    business_name: store.business_name ?? "",
    business_address: store.business_address ?? "",
    business_tin: store.business_tin ?? "",
    receipt_header_lines: (store.receipt_header_lines ?? []).join("\n"),
    receipt_footer_lines: (store.receipt_footer_lines ?? []).join("\n"),
    time_zone: store.time_zone,
    stock_policy: store.stock_policy,
    offline_credit_mode: store.offline_credit_mode,
    offline_credit_cap: numberText(store.offline_credit_cap),
  }
}

function lineWidthNote(text: string): string {
  const lines = toLines(text)
  const wide = lines.filter((l) => l.length > WIDE_PAPER).length
  const narrow = lines.filter((l) => l.length > NARROW_PAPER).length
  if (wide) return `${wide} ${wide === 1 ? "line is" : "lines are"} longer than ${WIDE_PAPER} characters and will wrap on any paper.`
  if (narrow) return `${narrow} ${narrow === 1 ? "line is" : "lines are"} longer than ${NARROW_PAPER} characters and will wrap on 58 mm paper.`
  return `One per line. 58 mm paper fits ${NARROW_PAPER} characters per line, 80 mm fits ${WIDE_PAPER}.`
}

interface StoreSettingsFormProps {
  store: Store
  /** Owners and admins; managers see the settings read-only */
  canEdit: boolean
  onSaved: (store: Store) => void
}

export function StoreSettingsForm({ store, canEdit, onSaved }: StoreSettingsFormProps) {
  const form = useForm<Input, unknown, Output>({ resolver: zodResolver(schema), defaultValues: useMemo(() => defaults(store), [store]) })
  const { errors, isSubmitting, isDirty } = form.formState
  const mode = form.watch("offline_credit_mode")
  const header = form.watch("receipt_header_lines")
  const footer = form.watch("receipt_footer_lines")

  const submit = form.handleSubmit(async (values) => {
    try {
      const { store: saved } = await api.patch<{ store: Store }>(`/api/stores/${store.id}`, values)
      toast.success("Store settings saved. Terminals pick them up at their next sync.")
      form.reset(defaults(saved))
      onSaved(saved)
    } catch (error) {
      showServerError(error, form.setError, { fields: FIELDS })
    }
  })

  return (
    <form onSubmit={submit} noValidate>
      <fieldset disabled={!canEdit} className="grid gap-5">
        {!canEdit && (
          <p className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
            <Lock className="size-4 shrink-0" />
            Only owners and admins can change store settings.
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <StoreIcon className="size-5" />
              Store and business
            </CardTitle>
            <CardDescription>The business details are printed at the top of every receipt (BIR).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormField label="Store name" htmlFor="store-name" error={errors.name?.message} hint="How the store appears in the back office and on the tablet">
              <Input id="store-name" {...form.register("name")} aria-invalid={!!errors.name} />
            </FormField>
            <FormField label="Registered business name" htmlFor="store-business_name" optional error={errors.business_name?.message}>
              <Input id="store-business_name" {...form.register("business_name")} aria-invalid={!!errors.business_name} />
            </FormField>
            <FormField label="Registered address" htmlFor="store-business_address" optional error={errors.business_address?.message}>
              <Textarea id="store-business_address" rows={2} {...form.register("business_address")} aria-invalid={!!errors.business_address} />
            </FormField>
            <FormField
              label="TIN"
              htmlFor="store-business_tin"
              optional
              error={errors.business_tin?.message}
              hint="A bare number prints as “VAT REG TIN …”. A non-VAT store should type its label too, e.g. “NON-VAT REG TIN 000-000-000-000”."
            >
              <Input id="store-business_tin" placeholder="000-000-000-000" {...form.register("business_tin")} aria-invalid={!!errors.business_tin} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="size-5" />
              Receipt lines
            </CardTitle>
            <CardDescription>Extra lines above and below the receipt body, printed exactly as typed (e.g. an accreditation number or a thank-you).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField label="Header lines" htmlFor="store-receipt_header_lines" error={errors.receipt_header_lines?.message} hint={lineWidthNote(header)}>
              <Textarea id="store-receipt_header_lines" rows={4} className="font-mono text-sm" {...form.register("receipt_header_lines")} aria-invalid={!!errors.receipt_header_lines} />
            </FormField>
            <FormField label="Footer lines" htmlFor="store-receipt_footer_lines" error={errors.receipt_footer_lines?.message} hint={lineWidthNote(footer)}>
              <Textarea id="store-receipt_footer_lines" rows={4} className="font-mono text-sm" {...form.register("receipt_footer_lines")} aria-invalid={!!errors.receipt_footer_lines} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Warehouse className="size-5" />
              Time and stock
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <FormField label="Time zone" htmlFor="store-time_zone" error={errors.time_zone?.message} hint="Business days and Z-readings follow this clock">
              <Input id="store-time_zone" list="store-time-zones" autoComplete="off" className="sm:max-w-xs" {...form.register("time_zone")} aria-invalid={!!errors.time_zone} />
              <datalist id="store-time-zones">
                {TIME_ZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </FormField>
            <div className="grid gap-2">
              <p className="text-sm font-medium">When a sale needs more stock than the terminal has</p>
              <Controller
                control={form.control}
                name="stock_policy"
                render={({ field }) => <OptionCards label="Stock policy" value={field.value} onChange={field.onChange} options={STOCK_POLICIES} disabled={!canEdit} className="sm:grid-cols-2" />}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-5" />
              Store credit while offline
            </CardTitle>
            <CardDescription>
              Offline, a terminal only knows each customer&apos;s balance as of its last sync. A block or limit change made here also reaches it only at its next sync.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Controller
              control={form.control}
              name="offline_credit_mode"
              render={({ field }) => <OptionCards label="Offline store credit" value={field.value} onChange={field.onChange} options={CREDIT_MODES} disabled={!canEdit} />}
            />
            {mode === "C" && (
              <FormField label="Most a customer may charge offline (₱)" htmlFor="store-offline_credit_cap" error={errors.offline_credit_cap?.message} className="sm:max-w-xs">
                <Input id="store-offline_credit_cap" inputMode="decimal" placeholder="0.00" {...form.register("offline_credit_cap")} aria-invalid={!!errors.offline_credit_cap} />
              </FormField>
            )}
          </CardContent>
        </Card>

        <FormError message={errors.root?.server?.message} />

        {canEdit && (
          <div className="bg-background/95 sticky bottom-0 -mx-4 flex justify-end gap-2 border-t px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
            <Button type="button" variant="outline" disabled={!isDirty || isSubmitting} onClick={() => form.reset(defaults(store))}>
              Discard changes
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="animate-spin" /> : <Save />}
              Save settings
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  )
}
