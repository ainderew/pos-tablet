"use client"

import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatMoney } from "@/components/common/format"
import { Segmented } from "@/components/common/segmented"
import { FormError, FormField } from "@/components/forms/form-field"
import { MONEY, numberInput, optionalText, toNumber } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { Customer, LedgerEntry, PaymentMethod } from "@/lib/api-client"

export const PAYMENT_METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "GCASH", label: "GCash" },
  { value: "MAYA", label: "Maya" },
  { value: "CARD", label: "Card" },
]

// POST /api/customers/:id/payments: amount above 0 (2 decimals), one of the four methods
const schema = z.object({
  amount: numberInput("Enter the amount paid", { ...MONEY, greaterThan: 0 }),
  payment_method: z.enum(["CASH", "GCASH", "MAYA", "CARD"]),
  reference_number: optionalText(100),
  notes: optionalText(500),
})

type Input = z.input<typeof schema>
type Output = z.output<typeof schema>

export interface PaymentResult {
  entry: LedgerEntry
  balance: number
  customer: Customer
}

export function PaymentForm({ customer, onRecorded, onCancel }: { customer: Customer; onRecorded: (result: PaymentResult) => void; onCancel: () => void }) {
  const form = useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: { amount: "", payment_method: "CASH", reference_number: "", notes: "" },
  })
  const { errors, isSubmitting } = form.formState
  const method = form.watch("payment_method")
  const typed = form.watch("amount")
  const balance = Number(customer.balance ?? 0)
  const overpaying = balance > 0 && Number.isFinite(toNumber(typed)) && toNumber(typed) > balance

  const submit = form.handleSubmit(async (values) => {
    try {
      const result = await api.post<PaymentResult>(`/api/customers/${customer.id}/payments`, values)
      toast.success(`${formatMoney(values.amount)} payment recorded. Balance: ${formatMoney(result.balance)}`)
      onRecorded(result)
    } catch (error) {
      showServerError(error, form.setError, { fields: ["amount", "payment_method", "reference_number", "notes"] })
    }
  })

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="bg-muted flex items-center justify-between rounded-lg px-3 py-2 text-sm">
        <span className="text-muted-foreground">Balance now</span>
        <span className="font-semibold tabular-nums">{formatMoney(balance)}</span>
      </div>
      <FormField
        label="Amount paid (₱)"
        htmlFor="payment-amount"
        error={errors.amount?.message}
        hint={overpaying ? `That's more than the balance: they'll have ${formatMoney(toNumber(typed) - balance)} of credit in their favor.` : undefined}
      >
        <Input id="payment-amount" inputMode="decimal" autoFocus autoComplete="off" placeholder="0.00" className="text-lg font-semibold" {...form.register("amount")} aria-invalid={!!errors.amount} />
      </FormField>
      <div className="grid gap-1.5">
        <Label>Paid with</Label>
        <Controller control={form.control} name="payment_method" render={({ field }) => <Segmented label="Paid with" value={field.value} onChange={field.onChange} options={PAYMENT_METHODS} />} />
      </div>
      {method !== "CASH" && (
        <FormField label="Reference number" htmlFor="payment-reference_number" optional error={errors.reference_number?.message}>
          <Input id="payment-reference_number" autoComplete="off" {...form.register("reference_number")} />
        </FormField>
      )}
      <FormField label="Note" htmlFor="payment-notes" optional error={errors.notes?.message}>
        <Input id="payment-notes" autoComplete="off" {...form.register("notes")} />
      </FormField>
      <FormError message={errors.root?.server?.message} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Record payment
        </Button>
      </div>
    </form>
  )
}
