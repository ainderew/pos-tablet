"use client"

import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Segmented } from "@/components/common/segmented"
import { FormError, FormField } from "@/components/forms/form-field"
import { optionalText, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { Terminal } from "@/lib/api-client"

// POST /api/stores/:storeId/terminals: a name, a kind, and optional BIR registration (80 characters each)
const schema = z.object({
  name: requiredText("Give the terminal a name", 80),
  kind: z.enum(["tablet", "desktop"]),
  ptu_number: optionalText(80),
  serial_number: optionalText(80),
  min: optionalText(80),
})

type Input = z.input<typeof schema>
type Output = z.output<typeof schema>

export function TerminalForm({ storeId, onCreated, onCancel }: { storeId: string; onCreated: (terminal: Terminal) => void; onCancel: () => void }) {
  const form = useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", kind: "tablet", ptu_number: "", serial_number: "", min: "" },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (values) => {
    try {
      const { terminal } = await api.post<{ terminal: Terminal }>(`/api/stores/${storeId}/terminals`, values)
      toast.success(`${terminal.name} added`)
      onCreated(terminal)
    } catch (error) {
      showServerError(error, form.setError, { fields: ["name", "kind", "ptu_number", "serial_number", "min"] })
    }
  })

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormField label="Name" htmlFor="terminal-name" error={errors.name?.message} hint="e.g. Counter 1">
        <Input id="terminal-name" autoFocus autoComplete="off" {...form.register("name")} aria-invalid={!!errors.name} />
      </FormField>
      <div className="grid gap-1.5">
        <Label>Kind</Label>
        <Controller
          control={form.control}
          name="kind"
          render={({ field }) => (
            <Segmented
              label="Kind"
              value={field.value}
              onChange={field.onChange}
              options={[
                { value: "tablet", label: "Tablet" },
                { value: "desktop", label: "PC app" },
              ]}
            />
          )}
        />
      </div>
      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">BIR registration</legend>
        <p className="text-muted-foreground -mt-1 text-xs">Optional for now: printed on receipts once filled in. You can add them later.</p>
        <FormField label="PTU number" htmlFor="terminal-ptu_number" optional error={errors.ptu_number?.message}>
          <Input id="terminal-ptu_number" autoComplete="off" {...form.register("ptu_number")} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Serial number" htmlFor="terminal-serial_number" optional error={errors.serial_number?.message}>
            <Input id="terminal-serial_number" autoComplete="off" {...form.register("serial_number")} />
          </FormField>
          <FormField label="MIN" htmlFor="terminal-min" optional error={errors.min?.message} hint="Machine identification number">
            <Input id="terminal-min" autoComplete="off" {...form.register("min")} />
          </FormField>
        </div>
      </fieldset>
      <FormError message={errors.root?.server?.message} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Add terminal
        </Button>
      </div>
    </form>
  )
}
