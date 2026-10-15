"use client"

import { useCallback, useEffect, useState } from "react"
import { History } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { formatDateTime, formatDelta, formatQuantity } from "@/components/common/format"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { api, errorMessage, isAbort } from "@/lib/api-client"
import type { Product, StockMovement, StockMovementReason } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { StockMovementForm } from "./stock-movement-form"

const REASON_LABELS: Record<StockMovementReason, string> = { RESTOCK: "Restock", ADJUSTMENT: "Adjustment", SALE: "Sale", VOID: "Void" }
const HISTORY_LIMIT = 30

interface StockDialogProps {
  product: Product | null
  store: { id: string; name: string }
  onOpenChange: (open: boolean) => void
  /** A movement was recorded: the product's new stock at this store */
  onChanged: (productId: string, stockLevel: number) => void
}

export function StockDialog({ product, store, onOpenChange, onChanged }: StockDialogProps) {
  const [level, setLevel] = useState(0)
  useEffect(() => setLevel(Number(product?.stock_level ?? 0)), [product])

  return (
    <Dialog open={!!product} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {product && (
          <>
            <DialogHeader>
              <DialogTitle>Stock: {product.name}</DialogTitle>
              <DialogDescription>
                {formatQuantity(level, product.unit_type)} at {store.name}
              </DialogDescription>
            </DialogHeader>
            <StockMovementForm
              key={product.id}
              product={product}
              storeId={store.id}
              currentLevel={level}
              onRecorded={({ stock_level }) => {
                setLevel(Number(stock_level))
                onChanged(product.id, Number(stock_level))
              }}
            />
            <Separator />
            <MovementHistory productId={product.id} storeId={store.id} unitType={product.unit_type} refreshKey={level} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function MovementHistory({ productId, storeId, unitType, refreshKey }: { productId: string; storeId: string; unitType: Product["unit_type"]; refreshKey: number }) {
  const [movements, setMovements] = useState<StockMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    api
      .get<{ movements: StockMovement[] }>(`/api/stores/${storeId}/stock-movements`, { query: { product_id: productId, limit: HISTORY_LIMIT }, signal: controller.signal })
      .then(({ movements }) => setMovements(movements))
      .catch((e) => !isAbort(e) && setError(errorMessage(e, "Couldn't load the stock history")))
    return () => controller.abort()
  }, [productId, storeId, refreshKey, attempt])

  return (
    <section className="grid gap-2" aria-labelledby="stock-history-heading">
      <h3 id="stock-history-heading" className="flex items-center gap-2 text-sm font-semibold">
        <History className="size-4" />
        Recent movements
      </h3>
      {error ? (
        <ErrorState message={error} onRetry={retry} className="py-6" />
      ) : !movements ? (
        <LoadingState className="py-6" />
      ) : movements.length === 0 ? (
        <EmptyState title="No movements yet" description="Restocks, adjustments and sales at this store appear here." className="py-6" />
      ) : (
        <ul className="divide-y rounded-lg border">
          {movements.map((m) => {
            const delta = Number(m.quantity_delta)
            return (
              <li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{REASON_LABELS[m.reason] ?? m.reason}</Badge>
                    <span className="text-muted-foreground text-xs">{m.terminal_id ? "From a terminal" : "Back office"}</span>
                  </div>
                  {m.note && <p className="mt-1 break-words">{m.note}</p>}
                  <p className="text-muted-foreground mt-0.5 text-xs">{formatDateTime(m.created_at)}</p>
                </div>
                <span className={cn("shrink-0 font-semibold tabular-nums", delta > 0 ? "text-success" : "text-destructive")}>
                  {formatDelta(delta)} {unitType === "WEIGHT" ? "kg" : ""}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
