"use client"

import { useMemo } from "react"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/common/segmented"
import { formatQuantity } from "@/components/common/format"
import { FormError, FormField } from "@/components/forms/form-field"
import { MAX_QUANTITY, numberProblem, optionalText, toNumber } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { Product, StockMovement, UnitType } from "@/lib/api-client"

type Mode = "RESTOCK" | "ADJUSTMENT"

// POST stock-movements: quantity_delta ≠ 0, at most 3 decimals, a whole number for QUANTITY products.
// A restock adds stock; an adjustment can add or remove it.
export function stockMovementSchema(unitType: UnitType) {
  return z
    .object({
      reason: z.enum(["RESTOCK", "ADJUSTMENT"]),
      quantity: z.string().trim(),
      note: optionalText(500),
    })
    .superRefine((v, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["quantity"], message })
      if (!v.quantity) return issue(v.reason === "RESTOCK" ? "Enter how much you received" : "Enter how much to add or remove")
      const problem = numberProblem(v.quantity, { decimals: 3, allowNegative: v.reason === "ADJUSTMENT", nonZero: true, max: MAX_QUANTITY })
      if (problem === "Can't be negative") return issue("A restock adds stock. To remove stock, use Adjust.")
      if (problem) return issue(problem)
      if (unitType === "QUANTITY" && !Number.isInteger(toNumber(v.quantity))) issue("Sold by the piece: use a whole number")
    })
    .transform((v) => ({ ...v, quantity: toNumber(v.quantity) }))
}

type Input = z.input<ReturnType<typeof stockMovementSchema>>
type Output = z.output<ReturnType<typeof stockMovementSchema>>

interface StockMovementFormProps {
  product: Pick<Product, "id" | "name" | "unit_type">
  storeId: string
  currentLevel: number
  onRecorded: (result: { movement: StockMovement; stock_level: number }) => void
}

export function StockMovementForm({ product, storeId, currentLevel, onRecorded }: StockMovementFormProps) {
  const schema = useMemo(() => stockMovementSchema(product.unit_type), [product.unit_type])
  const form = useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: { reason: "RESTOCK", quantity: "", note: "" },
  })
  const { errors, isSubmitting } = form.formState
  const reason = form.watch("reason")
  const typed = form.watch("quantity")
  const preview = useMemo(() => {
    const n = Number(typed.replace(/,/g, ""))
    if (!typed.trim() || !Number.isFinite(n) || n === 0) return null
    return currentLevel + n
  }, [typed, currentLevel])

  const submit = form.handleSubmit(async (values) => {
    try {
      const result = await api.post<{ movement: StockMovement; stock_level: number }>(`/api/stores/${storeId}/stock-movements`, {
        product_id: product.id,
        quantity_delta: values.quantity,
        reason: values.reason,
        ...(values.note ? { note: values.note } : {}),
      })
      toast.success(`Stock of ${product.name} is now ${formatQuantity(result.stock_level, product.unit_type)}`)
      form.reset({ reason: values.reason, quantity: "", note: "" })
      onRecorded(result)
    } catch (error) {
      showServerError(error, form.setError, { fields: ["quantity", "note"], paths: { quantity_delta: "quantity" } })
    }
  })

  const unit = product.unit_type === "WEIGHT" ? "kg" : "pcs"

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <Controller
        control={form.control}
        name="reason"
        render={({ field }) => (
          <Segmented
            label="Kind of change"
            value={field.value}
            onChange={(value: Mode) => {
              field.onChange(value)
              form.clearErrors("quantity")
            }}
            options={[
              { value: "RESTOCK", label: "Restock" },
              { value: "ADJUSTMENT", label: "Adjust" },
            ]}
          />
        )}
      />
      <FormField
        label={reason === "RESTOCK" ? `Quantity received (${unit})` : `Change (${unit})`}
        htmlFor="stock-quantity"
        error={errors.quantity?.message}
        hint={reason === "RESTOCK" ? "Added to the stock" : "Use a minus sign to remove stock, e.g. -2 for two damaged items"}
      >
        <Input id="stock-quantity" inputMode={reason === "RESTOCK" ? "decimal" : "text"} autoComplete="off" placeholder={reason === "RESTOCK" ? "0" : "e.g. -2"} {...form.register("quantity")} aria-invalid={!!errors.quantity} />
      </FormField>
      <FormField label="Note" htmlFor="stock-note" optional error={errors.note?.message} hint={reason === "ADJUSTMENT" ? "Why: damaged, expired, count correction…" : "Supplier, delivery receipt number…"}>
        <Input id="stock-note" autoComplete="off" {...form.register("note")} />
      </FormField>

      <div className="bg-muted flex items-center justify-between rounded-lg px-3 py-2 text-sm">
        <span className="text-muted-foreground">Stock after this</span>
        <span className="font-semibold tabular-nums">{preview === null ? "—" : formatQuantity(preview, product.unit_type)}</span>
      </div>

      <FormError message={errors.root?.server?.message} />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        {reason === "RESTOCK" ? "Record restock" : "Record adjustment"}
      </Button>
    </form>
  )
}
