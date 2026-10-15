"use client"

import { createContext, useContext } from "react"
import type { SessionUser, Store } from "@/lib/api-client"

export interface BackOfficeContextValue {
  /** Checked on the server from the session cookie before the shell rendered */
  user: SessionUser
  /** Stores the user may work in (GET /api/stores); null while loading */
  stores: Store[] | null
  storesError: string | null
  reloadStores: () => void
  /** Put a created or updated store into the list */
  upsertStore: (store: Store) => void
  /** The store in the URL, else the last one used, else the first */
  currentStoreId: string | null
  currentStore: Store | null
  /** Remember a store for the pages that aren't per store (categories, users) */
  rememberStore: (storeId: string) => void
}

export const BackOfficeContext = createContext<BackOfficeContextValue | null>(null)

export function useBackOffice(): BackOfficeContextValue {
  const value = useContext(BackOfficeContext)
  if (!value) throw new Error("useBackOffice must be used inside the back-office shell")
  return value
}

/** The store of a per-store page (rendered inside StoreGate, so it exists) */
export function useCurrentStore(): Store {
  const { currentStore } = useBackOffice()
  if (!currentStore) throw new Error("useCurrentStore must be used inside StoreGate")
  return currentStore
}

export const canEditStores = (user: SessionUser) => user.role === "OWNER" || user.role === "ADMIN"
