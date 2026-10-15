"use client"

import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FormError, FormField } from "@/components/forms/form-field"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api, ApiError } from "@/lib/api-client"

// Same rules as POST /api/auth/login
const schema = z.object({
  email: z.string().trim().min(1, "Enter your email").max(200, "At most 200 characters"),
  password: z.string().min(1, "Enter your password").max(200, "At most 200 characters"),
})

export function LoginForm() {
  const router = useRouter()
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (values) => {
    try {
      await api.post("/api/auth/login", values)
      router.replace("/stores")
      router.refresh()
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
        form.resetField("password")
        form.setError("root.server", { type: "server", message: error.message })
        form.setFocus("password")
        return
      }
      showServerError(error, form.setError, { fields: ["email", "password"] })
    }
  })

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormField label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="username" autoFocus {...form.register("email")} aria-invalid={!!errors.email} />
      </FormField>
      <FormField label="Password" htmlFor="password" error={errors.password?.message}>
        <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} aria-invalid={!!errors.password} />
      </FormField>
      <FormError message={errors.root?.server?.message} />
      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        Sign in
      </Button>
    </form>
  )
}
