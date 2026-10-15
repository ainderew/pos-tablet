"use client"

import { useCallback, useEffect, useState } from "react"
import { PageHeader } from "@/components/common/page-header"
import { ErrorState, LoadingState } from "@/components/common/states"
import { canEditStores, useBackOffice, useCurrentStore } from "@/components/back-office/back-office-context"
import { api, errorMessage } from "@/lib/api-client"
import type { Store } from "@/lib/api-client"
import { StoreSettingsForm } from "./store-settings-form"

export function StoreSettingsView() {
  const current = useCurrentStore()
  const { user, upsertStore } = useBackOffice()
  const [store, setStore] = useState<Store | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const { store } = await api.get<{ store: Store }>(`/api/stores/${current.id}`)
      setStore(store)
    } catch (e) {
      setLoadError(errorMessage(e, "Couldn't load the store's settings"))
    }
  }, [current.id])

  useEffect(() => {
    setStore(null)
    void load()
  }, [load])

  return (
    <div className="grid gap-5">
      <PageHeader title="Store settings" description={`${current.name}: receipts, time zone and what terminals do offline`} />
      {loadError && !store ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !store ? (
        <LoadingState />
      ) : (
        <StoreSettingsForm
          key={store.id}
          store={store}
          canEdit={canEditStores(user)}
          onSaved={(saved) => {
            setStore(saved)
            upsertStore(saved)
          }}
        />
      )}
    </div>
  )
}
