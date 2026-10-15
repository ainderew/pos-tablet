"use client"

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, Store as StoreIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { AddStoreDialog } from "./add-store-dialog"
import { canEditStores, useBackOffice } from "./back-office-context"

/** Per-store pages render only once the store is known to be one the user may work in */
export function StoreGate({ storeId, children }: { storeId: string; children: ReactNode }) {
  const { stores, storesError, reloadStores } = useBackOffice()
  if (!stores && storesError) return <ErrorState message={storesError} onRetry={reloadStores} />
  if (!stores) return <LoadingState label="Loading store…" />
  if (!stores.some((s) => s.id === storeId)) {
    return (
      <EmptyState
        icon={StoreIcon}
        title="Store not found"
        description="It doesn't exist, or you don't have access to it."
        action={
          <Button asChild variant="outline">
            <Link href="/stores">Go to my stores</Link>
          </Button>
        }
      />
    )
  }
  return children
}

/** /stores: open the last store used (or the first one) */
export function StoreRedirect() {
  const { user, stores, storesError, reloadStores, currentStoreId, upsertStore } = useBackOffice()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    if (stores?.length && currentStoreId) router.replace(`/stores/${currentStoreId}/products`)
  }, [stores, currentStoreId, router])

  if (!stores && storesError) return <ErrorState message={storesError} onRetry={reloadStores} />
  if (!stores || stores.length) return <LoadingState label="Opening your store…" />

  const canAdd = canEditStores(user)
  return (
    <>
      <EmptyState
        icon={StoreIcon}
        title="No stores yet"
        description={canAdd ? "Add your first store to manage its products, customers and terminals." : "You haven't been given access to a store. Ask an owner or admin to add you to one."}
        action={
          canAdd ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus />
              Add a store
            </Button>
          ) : null
        }
      />
      {canAdd && (
        <AddStoreDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onCreated={(store) => {
            upsertStore(store)
            router.replace(`/stores/${store.id}/settings`)
          }}
        />
      )}
    </>
  )
}
