"use client"

import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { FormError, FormField } from "@/components/forms/form-field"
import { MONEY, numberInput, numberText, optionalEmail, optionalText, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { CreditStatus, Customer } from "@/lib/api-client"

export const CREDIT_STATUSES: readonly { value: CreditStatus; label: string; description: string }[] = [
  { value: "ACTIVE", label: "Active", description: "Can buy on credit up to the limit" },
  { value: "OVERDUE", label: "Overdue", description: "Flagged as paying late; can still buy on credit" },
  { value: "BLOCKED", label: "Blocked", description: "Can't buy on credit. A payment that brings the balance back within the limit unblocks them." },
]

// The server's customer rules (lib/customers/input.ts)
const schema = z.object({
  full_name: requiredText("Enter the customer's name", 120),
  phone_number: optionalText(40),
  email: optionalEmail(),
  address: optionalText(300),
  credit_limit: numberInput("Enter a credit limit (0 for none)", MONEY),
  credit_status: z.enum(["ACTIVE", "BLOCKED", "OVERDUE"]),
})

type Input = z.input<typeof schema>
type Output = z.output<typeof schema>
const FIELDS = ["full_name", "phone_number", "email", "address", "credit_limit", "credit_status"] as const

interface CustomerFormProps {
  storeId: string
  customer?: Customer
  onSaved: (customer: Customer) => void
  onCancel: () => void
}

export function CustomerForm({ storeId, customer, onSaved, onCancel }: CustomerFormProps) {
  const form = useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: customer?.full_name ?? "",
      phone_number: customer?.phone_number ?? "",
      email: customer?.email ?? "",
      address: customer?.address ?? "",
      credit_limit: customer ? numberText(customer.credit_limit) : "0",
      credit_status: customer?.credit_status ?? "ACTIVE",
    },
  })
  const { errors, isSubmitting } = form.formState
  const status = form.watch("credit_status")

  const submit = form.handleSubmit(async ({ credit_status, ...values }) => {
    try {
      const saved = customer
        ? (await api.patch<{ customer: Customer }>(`/api/customers/${customer.id}`, { ...values, credit_status })).customer
        : (await api.post<{ customer: Customer }>(`/api/stores/${storeId}/customers`, values)).customer
      toast.success(customer ? `${saved.full_name} updated` : `${saved.full_name} added`)
      onSaved(saved)
    } catch (error) {
      showServerError(error, form.setError, { fields: FIELDS })
    }
  })

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormField label="Name" htmlFor="customer-full_name" error={errors.full_name?.message}>
        <Input id="customer-full_name" autoFocus={!customer} autoComplete="off" {...form.register("full_name")} aria-invalid={!!errors.full_name} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Phone" htmlFor="customer-phone_number" optional error={errors.phone_number?.message}>
          <Input id="customer-phone_number" type="tel" inputMode="tel" autoComplete="off" {...form.register("phone_number")} aria-invalid={!!errors.phone_number} />
        </FormField>
        <FormField label="Email" htmlFor="customer-email" optional error={errors.email?.message}>
          <Input id="customer-email" type="email" autoComplete="off" {...form.register("email")} aria-invalid={!!errors.email} />
        </FormField>
      </div>
      <FormField label="Address" htmlFor="customer-address" optional error={errors.address?.message}>
        <Textarea id="customer-address" rows={2} {...form.register("address")} aria-invalid={!!errors.address} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Credit limit (₱)" htmlFor="customer-credit_limit" error={errors.credit_limit?.message} hint="The most they may owe; 0 means no store credit">
          <Input id="customer-credit_limit" inputMode="decimal" {...form.register("credit_limit")} aria-invalid={!!errors.credit_limit} />
        </FormField>
        {customer && (
          <FormField label="Status" htmlFor="customer-credit_status" error={errors.credit_status?.message} hint={CREDIT_STATUSES.find((s) => s.value === status)?.description}>
            <Controller
              control={form.control}
              name="credit_status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="customer-credit_status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CREDIT_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        )}
      </div>
      <FormError message={errors.root?.server?.message} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {customer ? "Save changes" : "Add customer"}
        </Button>
      </div>
    </form>
  )
}
