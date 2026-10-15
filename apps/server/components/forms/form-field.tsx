import type { ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

interface FormFieldProps {
  label: ReactNode
  htmlFor?: string
  error?: string
  hint?: ReactNode
  optional?: boolean
  className?: string
  children: ReactNode
}

/** Label, control, hint and the field's error message */
export function FormField({ label, htmlFor, error, hint, optional, className, children }: FormFieldProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {optional && <span className="text-muted-foreground font-normal">(optional)</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-muted-foreground text-xs">{hint}</p>}
      {error && (
        <p className="text-destructive text-sm" id={htmlFor ? `${htmlFor}-error` : undefined}>
          {error}
        </p>
      )}
    </div>
  )
}

/** A problem with the whole form (network, permission, conflicts that aren't about one field) */
export function FormError({ message, className }: { message?: string; className?: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
