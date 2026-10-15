"use client"

import { useMemo } from "react"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ROLE_LABELS } from "@/components/common/format"
import { FormError, FormField } from "@/components/forms/form-field"
import { MIN_PASSWORD_LENGTH, optionalEmail, PIN_PATTERN, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api } from "@/lib/api-client"
import type { ManagedUser, SessionUser, Store, UserRole } from "@/lib/api-client"
import { assignableRoles, ROLE_DESCRIPTIONS, worksInEveryStore } from "./user-rules"

// The server's user rules (lib/users/input.ts): passwords of 10+ characters only for back-office
// roles and only with an email; PINs of 4 to 6 digits; store assignments only for managers and
// cashiers. Requiring a store for them is the form's own rule (otherwise they can work nowhere).
function userSchema(user?: ManagedUser) {
  return z
    .object({
      full_name: requiredText("Enter their name", 120),
      role: z.enum(["OWNER", "ADMIN", "MANAGER", "CASHIER"]),
      email: optionalEmail(),
      password: z.string(),
      pin: z.string().trim(),
      store_ids: z.array(z.string()),
    })
    .superRefine((v, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
      const backOffice = v.role !== "CASHIER"
      if (backOffice && v.password) {
        if (v.password.length < MIN_PASSWORD_LENGTH) issue("password", `Use at least ${MIN_PASSWORD_LENGTH} characters`)
        else if (v.password.length > 200) issue("password", "At most 200 characters")
      }
      const willHavePassword = backOffice && (!!v.password || !!user?.has_password)
      if (willHavePassword && v.email === null) issue("email", "Add an email: it's what they sign in with")
      if (v.pin && !PIN_PATTERN.test(v.pin)) issue("pin", "A PIN is 4 to 6 digits")
      if (!worksInEveryStore(v.role) && v.store_ids.length === 0) issue("store_ids", "Choose at least one store")
    })
}

type Input = z.input<ReturnType<typeof userSchema>>
type Output = z.output<ReturnType<typeof userSchema>>
const FIELDS = ["full_name", "role", "email", "password", "pin", "store_ids"] as const

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id))

interface UserFormProps {
  actor: SessionUser
  /** Undefined to add a user */
  user?: ManagedUser
  /** Stores the signed-in user may assign (theirs) */
  stores: Store[]
  onSaved: (user: ManagedUser) => void
  onCancel: () => void
}

export function UserForm({ actor, user, stores, onSaved, onCancel }: UserFormProps) {
  const isSelf = !!user && user.id === actor.id
  const roles = isSelf ? [user.role] : assignableRoles(actor)
  const initialStores = user && Array.isArray(user.store_ids) ? user.store_ids : stores.length === 1 ? [stores[0].id] : []
  const schema = useMemo(() => userSchema(user), [user])
  const form = useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: user?.full_name ?? "",
      role: user?.role ?? (roles.includes("CASHIER") ? "CASHIER" : roles[0]),
      email: user?.email ?? "",
      password: "",
      pin: "",
      store_ids: initialStores,
    },
  })
  const { errors, isSubmitting } = form.formState
  const role = form.watch("role")
  const backOffice = role !== "CASHIER"
  const perStore = !worksInEveryStore(role)
  // A manager can't change their own stores
  const storesLocked = isSelf && actor.role === "MANAGER"

  const submit = form.handleSubmit(async (values) => {
    try {
      let saved: ManagedUser
      if (!user) {
        const body = {
          full_name: values.full_name,
          role: values.role,
          ...(values.role !== "CASHIER" && values.email ? { email: values.email } : {}),
          ...(values.role !== "CASHIER" && values.password ? { password: values.password } : {}),
          ...(values.pin ? { pin: values.pin } : {}),
          ...(perStore ? { store_ids: values.store_ids } : {}),
        }
        saved = (await api.post<{ user: ManagedUser }>("/api/users", body)).user
      } else {
        // Only what changed: the server checks each change against who's asking
        const body: Record<string, unknown> = {}
        if (values.full_name !== user.full_name) body.full_name = values.full_name
        if (values.role !== user.role) body.role = values.role
        if (values.role !== "CASHIER" && values.email !== (user.email ?? null)) body.email = values.email
        if (values.role !== "CASHIER" && values.password) body.password = values.password
        // Cashiers have no password: becoming one removes it
        if (values.role === "CASHIER" && user.role !== "CASHIER" && user.has_password) body.password = null
        if (values.pin) body.pin = values.pin
        const before = Array.isArray(user.store_ids) ? user.store_ids : []
        if (perStore && !storesLocked && (worksInEveryStore(user.role) || !sameSet(values.store_ids, before))) body.store_ids = values.store_ids
        if (Object.keys(body).length === 0) {
          onCancel()
          return
        }
        saved = (await api.patch<{ user: ManagedUser }>(`/api/users/${user.id}`, body)).user
      }
      toast.success(user ? `${saved.full_name} updated` : `${saved.full_name} added`)
      onSaved(saved)
    } catch (error) {
      showServerError(error, form.setError, { fields: FIELDS, codes: { DUPLICATE_EMAIL: "email" } })
    }
  })

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormField label="Name" htmlFor="user-full_name" error={errors.full_name?.message}>
        <Input id="user-full_name" autoFocus={!user} autoComplete="off" {...form.register("full_name")} aria-invalid={!!errors.full_name} />
      </FormField>

      <FormField
        label="Role"
        htmlFor="user-role"
        error={errors.role?.message}
        hint={isSelf ? "You can't change your own role" : ROLE_DESCRIPTIONS[role as UserRole]}
      >
        <Controller
          control={form.control}
          name="role"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange} disabled={isSelf || roles.length < 2}>
              <SelectTrigger id="user-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </FormField>

      {backOffice ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Email" htmlFor="user-email" optional={!user?.has_password} error={errors.email?.message} hint="For signing in to the back office">
            <Input id="user-email" type="email" autoComplete="off" {...form.register("email")} aria-invalid={!!errors.email} />
          </FormField>
          <FormField
            label={user?.has_password ? "New password" : "Password"}
            htmlFor="user-password"
            optional
            error={errors.password?.message}
            hint={user?.has_password ? "Leave blank to keep it. A new password signs them out." : `At least ${MIN_PASSWORD_LENGTH} characters`}
          >
            <Input id="user-password" type="password" autoComplete="new-password" {...form.register("password")} aria-invalid={!!errors.password} />
          </FormField>
        </div>
      ) : (
        user?.has_password && user.role !== "CASHIER" && <p className="text-muted-foreground text-sm">Cashiers have no back-office password: theirs will be removed.</p>
      )}

      <FormField
        label={user?.has_pin ? "New PIN" : "PIN"}
        htmlFor="user-pin"
        optional={backOffice}
        error={errors.pin?.message}
        hint={user?.has_pin ? "Leave blank to keep it" : backOffice ? "4 to 6 digits, for the tablet and for approving voids" : "4 to 6 digits: cashiers sign in on the tablet with it"}
      >
        <Input id="user-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="sm:max-w-40" {...form.register("pin")} aria-invalid={!!errors.pin} />
      </FormField>

      {perStore ? (
        <fieldset className="grid gap-2" aria-describedby={errors.store_ids ? "user-stores-error" : undefined}>
          <legend className="mb-1 text-sm font-medium">Stores</legend>
          {storesLocked && <p className="text-muted-foreground text-xs">You can't change your own stores.</p>}
          <Controller
            control={form.control}
            name="store_ids"
            render={({ field }) => (
              <div className="grid gap-2 sm:grid-cols-2">
                {stores.map((store) => {
                  const checked = field.value.includes(store.id)
                  const id = `user-store-${store.id}`
                  return (
                    <div key={store.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={storesLocked}
                        onCheckedChange={(on) => field.onChange(on ? [...field.value, store.id] : field.value.filter((s) => s !== store.id))}
                      />
                      <Label htmlFor={id} className="flex-1 font-normal">
                        {store.name}
                      </Label>
                    </div>
                  )
                })}
              </div>
            )}
          />
          {errors.store_ids && (
            <p id="user-stores-error" className="text-destructive text-sm">
              {errors.store_ids.message}
            </p>
          )}
        </fieldset>
      ) : (
        <p className="text-muted-foreground text-sm">{ROLE_LABELS[role as UserRole]}s work in every store.</p>
      )}

      <FormError message={errors.root?.server?.message} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {user ? "Save changes" : "Add user"}
        </Button>
      </div>
    </form>
  )
}
