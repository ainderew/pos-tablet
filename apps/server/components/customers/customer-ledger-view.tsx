"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Banknote, BookOpen, Mail, MapPin, Pencil, Phone, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDateTime, formatMoney } from "@/components/common/format"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useCurrentStore } from "@/components/back-office/back-office-context"
import { api, ApiError, errorMessage } from "@/lib/api-client"
import type { Customer, LedgerEntry } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { CreditStatusBadge } from "./credit-display"
import { CustomerDialog, DeleteCustomerDialog, PaymentDialog } from "./customer-dialogs"
import { PAYMENT_METHODS } from "./payment-form"

const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label])) as Record<string, string>

// The server writes payment notes as "Payment via GCASH (ref). <note>" (POS-bir's wording)
const PAYMENT_PREFIX = /^Payment via \S+ (?:\(.*?\))?\.\s?/

/** Charges add to what the customer owes; payments and adjustments (a voided credit sale) take it off */
export function withRunningBalance(entries: LedgerEntry[]) {
  let balance = 0
  return entries.map((entry) => {
    const amount = Number(entry.amount)
    balance = Math.round((balance + (entry.entry_type === "CHARGE" ? amount : -amount)) * 100) / 100
    return { entry, balance }
  })
}

function describe(entry: LedgerEntry): { title: string; detail: string | null } {
  if (entry.entry_type === "CHARGE") return { title: entry.invoice_number ? `Bought on credit · ${entry.invoice_number}` : "Bought on credit", detail: entry.notes }
  if (entry.entry_type === "PAYMENT") {
    const method = entry.payment_method ? (METHOD_LABELS[entry.payment_method] ?? entry.payment_method) : null
    const note = entry.notes?.replace(PAYMENT_PREFIX, "").trim() || null
    return { title: ["Payment", method, entry.reference_number && `ref ${entry.reference_number}`].filter(Boolean).join(" · "), detail: note }
  }
  return { title: entry.invoice_number ? `Adjustment · ${entry.invoice_number}` : "Adjustment", detail: entry.notes }
}

export function CustomerLedgerView({ customerId }: { customerId: string }) {
  const store = useCurrentStore()
  const router = useRouter()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null)
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [{ customer }, { entries }] = await Promise.all([
        api.get<{ customer: Customer }>(`/api/customers/${customerId}`),
        api.get<{ entries: LedgerEntry[] }>(`/api/customers/${customerId}/ledger`),
      ])
      setCustomer(customer)
      setEntries(entries)
    } catch (e) {
      setLoadError({ message: errorMessage(e, "Couldn't load this customer"), notFound: e instanceof ApiError && e.status === 404 })
    }
  }, [customerId])

  useEffect(() => {
    void load()
  }, [load])

  // Newest first on screen, with the balance after each entry
  const rows = useMemo(() => (entries ? withRunningBalance(entries).reverse() : []), [entries])
  const listHref = `/stores/${store.id}/customers`

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link href={listHref}>
        <ArrowLeft />
        Customers
      </Link>
    </Button>
  )

  if (loadError && !customer) {
    return (
      <div className="grid gap-4">
        {back}
        {loadError.notFound ? <EmptyState title="Customer not found" description="They may have been deleted." /> : <ErrorState message={loadError.message} onRetry={() => void load()} />}
      </div>
    )
  }
  if (!customer || !entries) return <LoadingState />
  if (customer.store_id !== store.id) {
    return (
      <div className="grid gap-4">
        {back}
        <EmptyState
          title="This customer belongs to another store"
          action={
            <Button asChild variant="outline">
              <Link href={`/stores/${customer.store_id}/customers/${customer.id}`}>Open in their store</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const balance = Number(customer.balance ?? 0)
  const limit = Number(customer.credit_limit)

  return (
    <div className="grid gap-5">
      {back}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{customer.full_name}</h1>
            <CreditStatusBadge status={customer.credit_status} />
          </div>
          <div className="text-muted-foreground mt-2 grid gap-1 text-sm">
            {customer.phone_number && (
              <span className="flex items-center gap-2">
                <Phone className="size-4" />
                {customer.phone_number}
              </span>
            )}
            {customer.email && (
              <span className="flex items-center gap-2 break-all">
                <Mail className="size-4 shrink-0" />
                {customer.email}
              </span>
            )}
            {customer.address && (
              <span className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                {customer.address}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPaying(true)}>
            <Banknote />
            Record payment
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
          <Button variant="outline" onClick={() => setDeleting(true)} aria-label="Delete customer">
            <Trash2 />
            <span className="sm:hidden">Delete</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Figure label="Balance" value={formatMoney(balance)} tone={balance > 0 ? "text-destructive" : balance < 0 ? "text-success" : undefined} />
        <Figure label="Credit limit" value={formatMoney(limit)} />
        <Figure label="Available" value={formatMoney(Math.max(0, limit - balance))} />
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" />
            Ledger <span className="text-muted-foreground text-sm font-normal">· newest first</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <EmptyState title="No entries yet" description="Credit sales from the terminals and payments appear here." />
          ) : (
            <ul className="divide-y">
              {rows.map(({ entry, balance: after }) => {
                const { title, detail } = describe(entry)
                const charge = entry.entry_type === "CHARGE"
                return (
                  <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{title}</p>
                      {detail && <p className="text-muted-foreground break-words">{detail}</p>}
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {formatDateTime(entry.created_at)} · {entry.terminal_id ? "Terminal" : "Back office"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn("font-semibold tabular-nums", charge ? "text-destructive" : "text-success")}>
                        {charge ? "+" : "−"}
                        {formatMoney(entry.amount)}
                      </p>
                      <p className="text-muted-foreground text-xs tabular-nums">Balance {formatMoney(after)}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <CustomerDialog storeId={store.id} customer={customer} open={editing} onOpenChange={setEditing} onSaved={() => void load()} />
      <PaymentDialog customer={paying ? customer : null} onOpenChange={setPaying} onRecorded={() => void load()} />
      <DeleteCustomerDialog customer={deleting ? customer : null} onOpenChange={setDeleting} onDeleted={() => router.replace(listHref)} />
    </div>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-card rounded-xl border p-3 shadow-sm sm:p-4">
      <p className="text-muted-foreground text-xs font-medium sm:text-sm">{label}</p>
      <p className={cn("truncate text-lg font-bold tabular-nums sm:text-2xl", tone)}>{value}</p>
    </div>
  )
}
