"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import { useParams, usePathname, useRouter } from "next/navigation"
import { LogOut, Menu, MonitorSmartphone, Package, Plus, Settings, Store as StoreIcon, Tags, UserCog, Users } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { ROLE_LABELS } from "@/components/common/format"
import { api, errorMessage, onUnauthorized } from "@/lib/api-client"
import type { SessionUser, Store } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { AddStoreDialog } from "./add-store-dialog"
import { BackOfficeContext, canEditStores } from "./back-office-context"
import type { BackOfficeContextValue } from "./back-office-context"

const LAST_STORE_KEY = "pos.back-office.store"

interface NavItem {
  label: string
  icon: LucideIcon
  /** Per-store pages: the section under /stores/:storeId */
  section?: string
  href?: string
}

const STORE_NAV: NavItem[] = [
  { label: "Products", icon: Package, section: "products" },
  { label: "Customers", icon: Users, section: "customers" },
  { label: "Terminals", icon: MonitorSmartphone, section: "terminals" },
  { label: "Store settings", icon: Settings, section: "settings" },
]

const ORG_NAV: NavItem[] = [
  { label: "Categories", icon: Tags, href: "/categories" },
  { label: "Users", icon: UserCog, href: "/users" },
]

function readLastStore(): string | null {
  try {
    return window.localStorage.getItem(LAST_STORE_KEY)
  } catch {
    return null
  }
}

function writeLastStore(storeId: string) {
  try {
    window.localStorage.setItem(LAST_STORE_KEY, storeId)
  } catch {
    // Private mode: the URL still carries the store
  }
}

export function BackOfficeShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const params = useParams<{ storeId?: string }>()
  const urlStoreId = typeof params?.storeId === "string" ? params.storeId : null
  const pathname = usePathname()
  const router = useRouter()

  const [stores, setStores] = useState<Store[] | null>(null)
  const [storesError, setStoresError] = useState<string | null>(null)
  const [lastStoreId, setLastStoreId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [addStoreOpen, setAddStoreOpen] = useState(false)

  // A session that ends while the page is open (expired, signed out elsewhere) goes back to sign-in
  useEffect(() => onUnauthorized(() => window.location.assign("/login")), [])

  useEffect(() => setLastStoreId(readLastStore()), [])

  const rememberStore = useCallback((storeId: string) => {
    writeLastStore(storeId)
    setLastStoreId(storeId)
  }, [])

  useEffect(() => {
    if (urlStoreId) rememberStore(urlStoreId)
  }, [urlStoreId, rememberStore])

  const reloadStores = useCallback(async () => {
    setStoresError(null)
    try {
      const { stores } = await api.get<{ stores: Store[] }>("/api/stores")
      setStores([...stores].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (error) {
      setStoresError(errorMessage(error, "Couldn't load your stores"))
    }
  }, [])

  useEffect(() => {
    void reloadStores()
  }, [reloadStores])

  const upsertStore = useCallback((store: Store) => {
    setStores((current) => {
      const list = current ?? []
      const next = list.some((s) => s.id === store.id) ? list.map((s) => (s.id === store.id ? { ...s, ...store } : s)) : [...list, store]
      return next.sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [])

  const currentStoreId = useMemo(() => {
    if (urlStoreId) return urlStoreId
    if (!stores) return lastStoreId
    if (lastStoreId && stores.some((s) => s.id === lastStoreId)) return lastStoreId
    return stores[0]?.id ?? null
  }, [urlStoreId, stores, lastStoreId])

  const currentStore = stores?.find((s) => s.id === currentStoreId) ?? null

  const value: BackOfficeContextValue = { user, stores, storesError, reloadStores, upsertStore, currentStoreId, currentStore, rememberStore }

  // The same section in another store; a page about one record (a customer) goes back to its list
  const switchStore = (storeId: string) => {
    rememberStore(storeId)
    setMenuOpen(false)
    if (urlStoreId && pathname) {
      const section = pathname.split("/")[3] ?? "products"
      router.push(`/stores/${storeId}/${section}`)
    }
  }

  const signOut = async () => {
    try {
      await api.post("/api/auth/logout")
      router.replace("/login")
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't sign out"))
    }
  }

  const sidebar = (
    <SidebarContent
      user={user}
      stores={stores}
      storesError={storesError}
      currentStoreId={currentStoreId}
      pathname={pathname ?? ""}
      onSwitchStore={switchStore}
      onAddStore={() => setAddStoreOpen(true)}
      onNavigate={() => setMenuOpen(false)}
      onSignOut={signOut}
    />
  )

  return (
    <BackOfficeContext.Provider value={value}>
      <div className="bg-workspace min-h-dvh">
        <aside className="bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-30 hidden w-64 border-r md:block">{sidebar}</aside>

        <div className="md:pl-64">
          <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-2 backdrop-blur md:hidden">
            <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
              <Menu className="size-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{currentStore?.name ?? "Back office"}</p>
              <p className="text-muted-foreground truncate text-xs">{user.full_name}</p>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl px-4 py-5 md:px-8 md:py-8">{children}</main>
        </div>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="bg-sidebar w-72 gap-0 p-0 sm:max-w-xs">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Switch store and go to another page</SheetDescription>
            {sidebar}
          </SheetContent>
        </Sheet>

        {canEditStores(user) && (
          <AddStoreDialog
            open={addStoreOpen}
            onOpenChange={setAddStoreOpen}
            onCreated={(store) => {
              upsertStore(store)
              rememberStore(store.id)
              router.push(`/stores/${store.id}/settings`)
            }}
          />
        )}
      </div>
    </BackOfficeContext.Provider>
  )
}

interface SidebarContentProps {
  user: SessionUser
  stores: Store[] | null
  storesError: string | null
  currentStoreId: string | null
  pathname: string
  onSwitchStore: (storeId: string) => void
  onAddStore: () => void
  onNavigate: () => void
  onSignOut: () => void
}

function SidebarContent({ user, stores, storesError, currentStoreId, pathname, onSwitchStore, onAddStore, onNavigate, onSignOut }: SidebarContentProps) {
  const storeKnown = !!currentStoreId && (!stores || stores.some((s) => s.id === currentStoreId))

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
          <StoreIcon className="size-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">General Store POS</p>
          <p className="text-muted-foreground text-xs">Back office</p>
        </div>
      </div>

      <div className="grid gap-1.5 border-b p-3">
        <span className="text-muted-foreground px-1 text-xs font-medium">Store</span>
        <div className="flex items-center gap-2">
          <Select value={storeKnown ? (currentStoreId ?? undefined) : undefined} onValueChange={onSwitchStore} disabled={!stores?.length}>
            <SelectTrigger className="bg-background w-full min-w-0" aria-label="Store">
              <SelectValue placeholder={storesError ? "Couldn't load stores" : stores ? "No stores yet" : "Loading stores…"} />
            </SelectTrigger>
            <SelectContent>
              {stores?.map((store) => (
                <SelectItem key={store.id} value={store.id}>
                  {store.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canEditStores(user) && (
            <Button variant="outline" size="icon" className="bg-background shrink-0" aria-label="Add a store" title="Add a store" onClick={onAddStore}>
              <Plus />
            </Button>
          )}
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3" aria-label="Main">
        <NavGroup label="This store">
          {STORE_NAV.map((item) => {
            const href = currentStoreId ? `/stores/${currentStoreId}/${item.section}` : null
            return <NavLink key={item.label} item={item} href={href} active={!!href && pathname.startsWith(href)} onNavigate={onNavigate} />
          })}
        </NavGroup>
        <NavGroup label="Organization">
          {ORG_NAV.map((item) => (
            <NavLink key={item.label} item={item} href={item.href!} active={pathname.startsWith(item.href!)} onNavigate={onNavigate} />
          ))}
        </NavGroup>
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 px-1">
          <p className="truncate text-sm font-medium">{user.full_name}</p>
          <p className="text-muted-foreground truncate text-xs">
            {ROLE_LABELS[user.role]}
            {user.email ? ` · ${user.email}` : ""}
          </p>
        </div>
        <Button variant="outline" className="bg-background w-full justify-start" onClick={onSignOut}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </div>
  )
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <p className="text-muted-foreground px-2 pb-1 text-xs font-medium">{label}</p>
      {children}
    </div>
  )
}

function NavLink({ item, href, active, onNavigate }: { item: NavItem; href: string | null; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon
  const className = cn(
    "flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
    active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
    !href && "pointer-events-none opacity-50"
  )
  if (!href) {
    return (
      <span className={className} aria-disabled>
        <Icon className="size-4" />
        {item.label}
      </span>
    )
  }
  return (
    <Link href={href} className={className} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <Icon className="size-4" />
      {item.label}
    </Link>
  )
}
