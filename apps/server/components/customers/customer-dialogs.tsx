"use client"

import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { formatMoney } from "@/components/common/format"
import { api, ApiError } from "@/lib/api-client"
import type { Customer } from "@/lib/api-client"
import { CustomerForm } from "./customer-form"
import { PaymentForm } from "./payment-form"
import type { PaymentResult } from "./payment-form"

export function CustomerDialog({
  storeId,
  customer,
  open,
  onOpenChange,
  onSaved,
}: {
  storeId: string
  /** Undefined to add a customer */
  customer?: Customer
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (customer: Customer) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer ? "Edit customer" : "Add a customer"}</DialogTitle>
          <DialogDescription>Store-credit customers belong to this store.</DialogDescription>
        </DialogHeader>
        {open && (
          <CustomerForm
            key={customer?.id ?? "new"}
            storeId={storeId}
            customer={customer}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onOpenChange(false)
              onSaved(saved)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PaymentDialog({ customer, onOpenChange, onRecorded }: { customer: Customer | null; onOpenChange: (open: boolean) => void; onRecorded: (result: PaymentResult) => void }) {
  return (
    <Dialog open={!!customer} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>{customer?.full_name} paid in the office, not at a terminal.</DialogDescription>
        </DialogHeader>
        {customer && (
          <PaymentForm
            key={customer.id}
            customer={customer}
            onCancel={() => onOpenChange(false)}
            onRecorded={(result) => {
              onOpenChange(false)
              onRecorded(result)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function DeleteCustomerDialog({ customer, onOpenChange, onDeleted }: { customer: Customer | null; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  return (
    <ConfirmDialog
      open={!!customer}
      onOpenChange={onOpenChange}
      title={`Delete ${customer?.full_name ?? "customer"}?`}
      description="They disappear from this store's customer list and from the terminals at their next sync. Their ledger is kept."
      confirmLabel="Delete customer"
      destructive
      onConfirm={async () => {
        if (!customer) return
        await api.delete(`/api/customers/${customer.id}`)
        toast.success(`${customer.full_name} deleted`)
        onDeleted()
      }}
      renderError={(error) => <HasBalanceError error={error} />}
    />
  )
}

/** HAS_BALANCE explained: a customer can only be deleted once they're square with the store */
export function HasBalanceError({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || error.code !== "HAS_BALANCE") return null
  return (
    <Alert className="border-warning/50">
      <AlertTriangle className="text-warning" />
      <AlertTitle>The balance isn&apos;t zero</AlertTitle>
      <AlertDescription>
        <p>{error.message}.</p>
        <p>A customer can only be deleted at a {formatMoney(0)} balance.</p>
      </AlertDescription>
    </Alert>
  )
}
