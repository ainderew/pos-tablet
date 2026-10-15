"use client"

import { useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FormError } from "@/components/forms/form-field"
import { requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { Category } from "@/lib/api-client"

const schema = z.object({ name: requiredText("Enter a category name", 100) })

/** Create (POST /api/categories) or rename (PATCH /api/categories/:id) */
export function CategoryNameForm({ category, onSaved, onCancel }: { category?: Category; onSaved: (category: Category) => void; onCancel?: () => void }) {
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: category?.name ?? "" },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async ({ name }) => {
    if (category && name === category.name) return onCancel?.()
    try {
      const saved = category
        ? (await api.patch<{ category: Category }>(`/api/categories/${category.id}`, { name })).category
        : (await api.post<{ category: Category }>("/api/categories", { name })).category
      toast.success(category ? `Renamed to ${saved.name}` : `${saved.name} added`)
      form.reset({ name: category ? saved.name : "" })
      onSaved(saved)
    } catch (error) {
      showServerError(error, form.setError, { fields: ["name"], codes: { DUPLICATE_NAME: "name" } })
    }
  })

  const id = category ? `category-name-${category.id}` : "category-name-new"
  return (
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <div className="flex gap-2">
        <Input
          id={id}
          aria-label={category ? "Category name" : "New category name"}
          placeholder={category ? undefined : "New category, e.g. Beverages"}
          autoFocus={!!category}
          autoComplete="off"
          {...form.register("name")}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? `${id}-error` : undefined}
        />
        {category && onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting} className="shrink-0">
          {isSubmitting && <Loader2 className="animate-spin" />}
          {category ? "Save" : "Add"}
        </Button>
      </div>
      {errors.name && (
        <p id={`${id}-error`} className="text-destructive text-sm">
          {errors.name.message}
        </p>
      )}
      <FormError message={errors.root?.server?.message} />
    </form>
  )
}
