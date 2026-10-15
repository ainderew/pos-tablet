"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { CheckCircle2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { FormError, FormField } from "@/components/forms/form-field"
import { MIN_PASSWORD_LENGTH, PIN_PATTERN, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api, ApiError } from "@/lib/api-client"

// Same rules as POST /api/setup, plus the password typed twice
const schema = z
  .object({
    setup_token: z.string().trim().min(1, "Enter the setup token from the server's .env"),
    organization_name: requiredText("Enter your business name", 120),
    store_name: requiredText("Enter the first store's name", 120),
    owner_name: requiredText("Enter your name", 120),
    email: z.string().trim().min(1, "Enter your email").pipe(z.email("Enter a valid email address").max(200, "At most 200 characters")),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200, "At most 200 characters"),
    confirm_password: z.string(),
    pin: z
      .string()
      .trim()
      .refine((v) => !v || PIN_PATTERN.test(v), "A PIN is 4 to 6 digits")
      .transform((v) => v || undefined),
  })
  .refine((v) => v.password === v.confirm_password, { path: ["confirm_password"], message: "The passwords don't match" })

type Fields = z.input<typeof schema>
const FIELDS = ["setup_token", "organization_name", "store_name", "owner_name", "email", "password", "pin"] as const

export function SetupForm() {
  const router = useRouter()
  const [alreadySetUp, setAlreadySetUp] = useState(false)
  const form = useForm<Fields, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { setup_token: "", organization_name: "", store_name: "", owner_name: "", email: "", password: "", confirm_password: "", pin: "" },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async ({ confirm_password: _, ...values }) => {
    try {
      await api.post("/api/setup", values)
    } catch (error) {
      if (error instanceof ApiError && error.code === "ALREADY_SET_UP") return setAlreadySetUp(true)
      if (error instanceof ApiError && error.status === 403) {
        return form.setError("setup_token", { type: "server", message: "That setup token is wrong" }, { shouldFocus: true })
      }
      if (error instanceof ApiError && error.status === 404) {
        return form.setError("root.server", { type: "server", message: "Setup isn't turned on for this server. Set SETUP_TOKEN in its .env and restart it." })
      }
      return showServerError(error, form.setError, { fields: FIELDS })
    }
    // Set up: sign straight in as the new owner
    try {
      await api.post("/api/auth/login", { email: values.email, password: values.password })
      toast.success("Your back office is ready")
      router.replace("/stores")
      router.refresh()
    } catch {
      toast.success("Setup complete. Sign in to continue.")
      router.replace("/login")
    }
  })

  if (alreadySetUp) {
    return (
      <Alert>
        <CheckCircle2 />
        <AlertTitle>This server is already set up</AlertTitle>
        <AlertDescription>
          <p>Setup only runs once. Sign in with your account, or ask the owner to add you as a user.</p>
          <Button asChild className="mt-2">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormField label="Setup token" htmlFor="setup_token" error={errors.setup_token?.message} hint="SETUP_TOKEN in the server's .env file">
        <Input id="setup_token" autoComplete="off" autoFocus {...form.register("setup_token")} aria-invalid={!!errors.setup_token} />
      </FormField>

      <Separator />

      <FormField label="Business name" htmlFor="organization_name" error={errors.organization_name?.message} hint="Also used as the first store's registered business name on receipts">
        <Input id="organization_name" autoComplete="organization" {...form.register("organization_name")} aria-invalid={!!errors.organization_name} />
      </FormField>
      <FormField label="First store" htmlFor="store_name" error={errors.store_name?.message} hint="e.g. Main branch">
        <Input id="store_name" {...form.register("store_name")} aria-invalid={!!errors.store_name} />
      </FormField>

      <Separator />

      <FormField label="Your name" htmlFor="owner_name" error={errors.owner_name?.message}>
        <Input id="owner_name" autoComplete="name" {...form.register("owner_name")} aria-invalid={!!errors.owner_name} />
      </FormField>
      <FormField label="Email" htmlFor="setup_email" error={errors.email?.message} hint="You'll sign in to the back office with this">
        <Input id="setup_email" type="email" autoComplete="email" {...form.register("email")} aria-invalid={!!errors.email} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Password" htmlFor="setup_password" error={errors.password?.message} hint={`At least ${MIN_PASSWORD_LENGTH} characters`}>
          <Input id="setup_password" type="password" autoComplete="new-password" {...form.register("password")} aria-invalid={!!errors.password} />
        </FormField>
        <FormField label="Confirm password" htmlFor="confirm_password" error={errors.confirm_password?.message}>
          <Input id="confirm_password" type="password" autoComplete="new-password" {...form.register("confirm_password")} aria-invalid={!!errors.confirm_password} />
        </FormField>
      </div>
      <FormField label="PIN" htmlFor="setup_pin" optional error={errors.pin?.message} hint="4 to 6 digits, for signing in on the tablet and approving voids">
        <Input id="setup_pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} {...form.register("pin")} aria-invalid={!!errors.pin} />
      </FormField>

      <FormError message={errors.root?.server?.message} />
      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        Set up the back office
      </Button>
    </form>
  )
}
