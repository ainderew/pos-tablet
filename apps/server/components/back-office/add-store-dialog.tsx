"use client"

import { useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { FormError, FormField } from "@/components/forms/form-field"
import { optionalText, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { Store } from "@/lib/api-client"

const schema = z.object({
  name: requiredText("Enter the store's name", 120),
  business_name: optionalText(200),
})

/** Owners and admins: POST /api/stores */
export function AddStoreDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (store: Store) => void }) {
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", business_name: "" },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (values) => {
    try {
      const { store } = await api.post<{ store: Store }>("/api/stores", { name: values.name, ...(values.business_name ? { business_name: values.business_name } : {}) })
      toast.success(`${store.name} added`)
      form.reset()
      onCreated(store)
      onOpenChange(false)
    } catch (error) {
      showServerError(error, form.setError, { fields: ["name", "business_name"] })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a store</DialogTitle>
          <DialogDescription>Stores share the product catalog; stock, customers and terminals are per store.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <FormField label="Store name" htmlFor="store-name" error={errors.name?.message}>
            <Input id="store-name" autoFocus {...form.register("name")} aria-invalid={!!errors.name} />
          </FormField>
          <FormField label="Registered business name" htmlFor="store-business-name" optional error={errors.business_name?.message} hint="Printed on receipts. You can fill in the rest in the store's settings.">
            <Input id="store-business-name" {...form.register("business_name")} />
          </FormField>
          <FormError message={errors.root?.server?.message} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Add store
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
