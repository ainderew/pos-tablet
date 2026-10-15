"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Ban, Banknote, BookOpen, MoreHorizontal, Pencil, Plus, Trash2, Users, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatMoney } from "@/components/common/format"
import { PageHeader } from "@/components/common/page-header"
import { SearchInput } from "@/components/common/search-input"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useCurrentStore } from "@/components/back-office/back-office-context"
import { api, errorMessage, isAbort } from "@/lib/api-client"
import type { CreditStatus, Customer } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { CustomerDialog, DeleteCustomerDialog, PaymentDialog } from "./customer-dialogs"
import { CreditStatusBadge, CreditUsage } from "./credit-display"

const ALL = "all"

export function CustomersView() {
  const store = useCurrentStore()
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<CreditStatus | typeof ALL>(ALL)
  const [customers, setCustomers] = useState<Customer[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState<Customer | "new" | null>(null)
  const [paying, setPaying] = useState<Customer | null>(null)
  const [deleting, setDeleting] = useState<Customer | null>(null)

  const reload = useCallback(() => setReloadKey((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    api
      .get<{ customers: Customer[] }>(`/api/stores/${store.id}/customers`, { query: { search: search.trim(), status: status === ALL ? undefined : status }, signal: controller.signal })
      .then(({ customers }) => setCustomers(customers))
      .catch((e) => !isAbort(e) && setLoadError(errorMessage(e, "Couldn't load the customers")))
      .finally(() => !controller.signal.aborted && setLoading(false))
    return () => controller.abort()
  }, [store.id, search, status, reloadKey])

  const totals = useMemo(() => {
    const list = customers ?? []
    const owing = list.filter((c) => Number(c.balance ?? 0) > 0)
    return { receivable: owing.reduce((sum, c) => sum + Number(c.balance ?? 0), 0), owing: owing.length, blocked: list.filter((c) => c.credit_status === "BLOCKED").length }
  }, [customers])

  const filtering = !!search.trim() || status !== ALL
  const base = `/stores/${store.id}/customers`

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Customers"
        description={`Store credit (utang) at ${store.name}`}
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus />
            Add customer
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Stat label="Owed to the store" value={formatMoney(totals.receivable)} icon={Wallet} />
        <Stat label="Customers owing" value={String(totals.owing)} icon={Users} />
        <Stat label="Blocked" value={String(totals.blocked)} icon={Ban} tone={totals.blocked ? "destructive" : undefined} />
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-2 border-b p-3 sm:flex-row">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name, phone or email" className="flex-1" />
          <Select value={status} onValueChange={(v) => setStatus(v as CreditStatus | typeof ALL)}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="OVERDUE">Overdue</SelectItem>
              <SelectItem value="BLOCKED">Blocked</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loadError && !customers ? (
          <ErrorState message={loadError} onRetry={reload} />
        ) : !customers ? (
          <LoadingState />
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title={filtering ? "No customers match" : "No customers yet"}
            description={filtering ? "Try another search or status." : "Add the customers who buy on credit at this store."}
          />
        ) : (
          <div className={cn("transition-opacity", loading && "opacity-60")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Customer</TableHead>
                  <TableHead className="text-right sm:w-64 sm:text-left">Balance</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="w-10 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id} className={cn(c.credit_status === "BLOCKED" && "bg-muted/40")}>
                    <TableCell className="max-w-[10rem] pl-4 whitespace-normal sm:max-w-none">
                      <Link href={`${base}/${c.id}`} className="font-medium hover:underline">
                        {c.full_name}
                      </Link>
                      <div className="text-muted-foreground text-xs">{c.phone_number || c.email || "No contact details"}</div>
                      <CreditStatusBadge status={c.credit_status} className="mt-1 sm:hidden" />
                    </TableCell>
                    <TableCell className="text-right sm:text-left">
                      <CreditUsage balance={Number(c.balance ?? 0)} limit={Number(c.credit_limit)} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <CreditStatusBadge status={c.credit_status} />
                    </TableCell>
                    <TableCell className="pr-4">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${c.full_name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`${base}/${c.id}`}>
                              <BookOpen />
                              Ledger
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setPaying(c)}>
                            <Banknote />
                            Record payment
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setEditing(c)}>
                            <Pencil />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <CustomerDialog storeId={store.id} customer={editing === "new" ? undefined : (editing ?? undefined)} open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} onSaved={reload} />
      <PaymentDialog customer={paying} onOpenChange={(open) => !open && setPaying(null)} onRecorded={reload} />
      <DeleteCustomerDialog customer={deleting} onOpenChange={(open) => !open && setDeleting(null)} onDeleted={reload} />
    </div>
  )
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof Users; tone?: "destructive" }) {
  return (
    <div className="bg-card flex flex-col gap-1 rounded-xl border p-3 shadow-sm sm:p-4">
      <span className="text-muted-foreground flex items-center justify-between gap-1 text-xs font-medium sm:text-sm">
        {label}
        <Icon className="size-4 shrink-0" />
      </span>
      <span className={cn("truncate text-lg font-bold tabular-nums sm:text-2xl", tone === "destructive" && "text-destructive")}>{value}</span>
    </div>
  )
}
