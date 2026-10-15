"use client"

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/forms/form-field"
import { errorMessage } from "@/lib/api-client"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  destructive?: boolean
  /** Throw to keep the dialog open and show the error */
  onConfirm: () => Promise<void>
  /** Custom display for a failure (e.g. CATEGORY_IN_USE); return null for the default message */
  renderError?: (error: unknown) => ReactNode
}

/** "Are you sure?" that waits for the request and shows its error in place */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, destructive, onConfirm, renderError }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const custom = error ? renderError?.(error) : null

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? custom ?? <FormError message={errorMessage(error)} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{error ? "Close" : "Cancel"}</AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
