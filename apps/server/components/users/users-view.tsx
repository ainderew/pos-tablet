"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { KeyRound, MoreHorizontal, Pencil, Plus, Power, PowerOff, UserCog } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { ROLE_LABELS } from "@/components/common/format"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useBackOffice } from "@/components/back-office/back-office-context"
import { api, errorMessage } from "@/lib/api-client"
import type { ManagedUser, Store } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { assignableRoles, canManage, ROLE_ORDER } from "./user-rules"
import { UserForm } from "./user-form"

function storesLabel(user: ManagedUser, stores: Store[] | null): string {
  if (user.store_ids === "ALL" || user.role === "OWNER" || user.role === "ADMIN") return "All stores"
  if (user.store_ids.length === 0) return "No store"
  const names = user.store_ids.map((id) => stores?.find((s) => s.id === id)?.name).filter(Boolean)
  return names.length ? names.join(", ") : `${user.store_ids.length} store${user.store_ids.length === 1 ? "" : "s"}`
}

export function UsersView() {
  const { user: actor, stores } = useBackOffice()
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null)
  const [toggling, setToggling] = useState<ManagedUser | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const { users } = await api.get<{ users: ManagedUser[] }>("/api/users")
      setUsers(users)
    } catch (e) {
      setLoadError(errorMessage(e, "Couldn't load the users"))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(
    () =>
      [...(users ?? [])].sort(
        (a, b) => Number(b.is_active) - Number(a.is_active) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.full_name.localeCompare(b.full_name)
      ),
    [users]
  )

  const canAdd = assignableRoles(actor).length > 0
  const toggle = async () => {
    if (!toggling) return
    const activate = !toggling.is_active
    await api.patch(`/api/users/${toggling.id}`, { is_active: activate })
    toast.success(activate ? `${toggling.full_name} can sign in again` : `${toggling.full_name} deactivated`)
    void load()
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Users"
        description={actor.role === "MANAGER" ? "The people who work in your stores. You can add and manage cashiers." : "Back-office sign-in and tablet PINs for everyone in the business"}
        actions={
          canAdd && (
            <Button onClick={() => setEditing("new")} disabled={!stores}>
              <Plus />
              Add user
            </Button>
          )
        }
      />

      <Card className="gap-0 overflow-hidden py-0">
        {loadError && !users ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : !users ? (
          <LoadingState />
        ) : sorted.length === 0 ? (
          <EmptyState icon={UserCog} title="No users to show" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Stores</TableHead>
                <TableHead className="hidden sm:table-cell">Sign-in</TableHead>
                <TableHead className="w-10 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((u) => {
                const self = u.id === actor.id
                const manageable = canManage(actor, u)
                return (
                  <TableRow key={u.id} className={cn(!u.is_active && "text-muted-foreground")}>
                    <TableCell className="max-w-[11rem] pl-4 whitespace-normal sm:max-w-none">
                      <div className="font-medium">
                        {u.full_name}
                        {self && <span className="text-muted-foreground font-normal"> (you)</span>}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">{u.email ?? (u.role === "CASHIER" ? "Tablet only" : "No email")}</div>
                      <div className="text-muted-foreground text-xs md:hidden">{storesLabel(u, stores)}</div>
                      <SignInBadges user={u} className="mt-1 sm:hidden" />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={u.role === "OWNER" || u.role === "ADMIN" ? "default" : "secondary"}>{ROLE_LABELS[u.role]}</Badge>
                        {!u.is_active && <Badge variant="outline">Inactive</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-normal md:table-cell">{storesLabel(u, stores)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <SignInBadges user={u} />
                    </TableCell>
                    <TableCell className="pr-4">
                      {(self || manageable) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${u.full_name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setEditing(u)} disabled={!stores}>
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            {manageable && (
                              <DropdownMenuItem variant={u.is_active ? "destructive" : "default"} onSelect={() => setToggling(u)}>
                                {u.is_active ? <PowerOff /> : <Power />}
                                {u.is_active ? "Deactivate" : "Reactivate"}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "Add a user" : editing?.id === actor.id ? "Your account" : "Edit user"}</DialogTitle>
            <DialogDescription>New users and PIN changes reach a tablet at its next sync.</DialogDescription>
          </DialogHeader>
          {editing !== null && stores && (
            <UserForm
              key={editing === "new" ? "new" : editing.id}
              actor={actor}
              user={editing === "new" ? undefined : editing}
              stores={stores}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                void load()
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(open) => !open && setToggling(null)}
        title={toggling?.is_active ? `Deactivate ${toggling.full_name}?` : `Reactivate ${toggling?.full_name ?? "user"}?`}
        description={
          toggling?.is_active
            ? "They're signed out of the back office and can't sign in again until reactivated. Tablets stop accepting their PIN at their next sync."
            : "They can sign in again with their existing password and PIN."
        }
        confirmLabel={toggling?.is_active ? "Deactivate" : "Reactivate"}
        destructive={!!toggling?.is_active}
        onConfirm={toggle}
      />
    </div>
  )
}

function SignInBadges({ user, className }: { user: ManagedUser; className?: string }) {
  if (!user.has_password && !user.has_pin) return <span className={cn("text-muted-foreground text-xs", className)}>No sign-in yet</span>
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {user.has_password && (
        <Badge variant="outline">
          <KeyRound />
          Password
        </Badge>
      )}
      {user.has_pin && <Badge variant="outline">PIN</Badge>}
    </div>
  )
}
