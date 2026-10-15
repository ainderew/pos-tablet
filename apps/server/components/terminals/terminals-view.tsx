"use client"

import { useCallback, useEffect, useState } from "react"
import { Link2, Link2Off, Monitor, MonitorSmartphone, Plus, Tablet } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { formatDateTime, formatRelative } from "@/components/common/format"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useCurrentStore } from "@/components/back-office/back-office-context"
import { api, errorMessage } from "@/lib/api-client"
import type { Terminal } from "@/lib/api-client"
import { PairingDialog } from "./pairing-dialog"
import { TerminalForm } from "./terminal-form"

export function TerminalsView() {
  const store = useCurrentStore()
  const [terminals, setTerminals] = useState<Terminal[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [pairingWith, setPairingWith] = useState<Terminal | null>(null)
  const [unpairing, setUnpairing] = useState<Terminal | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const { terminals } = await api.get<{ terminals: Terminal[] }>(`/api/stores/${store.id}/terminals`)
      setTerminals(terminals)
    } catch (e) {
      setLoadError(errorMessage(e, "Couldn't load the terminals"))
    }
  }, [store.id])

  useEffect(() => {
    void load()
  }, [load])

  const closePairing = useCallback(() => {
    setPairingWith(null)
    void load()
  }, [load])

  const unpair = async () => {
    if (!unpairing) return
    const { revoked } = await api.post<{ revoked: number }>(`/api/terminals/${unpairing.id}/unpair`)
    toast.success(revoked ? `${unpairing.name} unpaired` : `${unpairing.name} had no paired device`)
    void load()
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Terminals"
        description={`The tablets and PCs that sell at ${store.name}. Each one numbers its own receipts.`}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add terminal
          </Button>
        }
      />

      {loadError && !terminals ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !terminals ? (
        <LoadingState />
      ) : terminals.length === 0 ? (
        <Card>
          <EmptyState
            icon={MonitorSmartphone}
            title="No terminals yet"
            description="Add the store's tablet, then pair it: it syncs sales and gets the catalog from here."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus />
                Add terminal
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {terminals.map((t) => (
            <TerminalCard key={t.id} terminal={t} onPair={() => setPairingWith(t)} onUnpair={() => setUnpairing(t)} />
          ))}
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add a terminal</DialogTitle>
            <DialogDescription>Then pair the device with it.</DialogDescription>
          </DialogHeader>
          {adding && (
            <TerminalForm
              storeId={store.id}
              onCancel={() => setAdding(false)}
              onCreated={(terminal) => {
                setAdding(false)
                void load()
                setPairingWith({ ...terminal, paired: false, last_seen_at: null })
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <PairingDialog terminal={pairingWith} onOpenChange={(open) => !open && closePairing()} onPaired={closePairing} />

      <ConfirmDialog
        open={!!unpairing}
        onOpenChange={(open) => !open && setUnpairing(null)}
        title={`Unpair ${unpairing?.name ?? "terminal"}?`}
        description="The device stops syncing until it's paired again. Anything it hasn't uploaded yet stays on the device, so let it sync first if you can."
        confirmLabel="Unpair"
        destructive
        onConfirm={unpair}
      />
    </div>
  )
}

function TerminalCard({ terminal: t, onPair, onUnpair }: { terminal: Terminal; onPair: () => void; onUnpair: () => void }) {
  const Icon = t.kind === "desktop" ? Monitor : Tablet
  const decommissioned = !!t.revoked_at
  const details = [
    ["PTU", t.ptu_number],
    ["S/N", t.serial_number],
    ["MIN", t.min],
  ] as const

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{t.name}</CardTitle>
            <p className="text-muted-foreground text-xs">{t.kind === "desktop" ? "PC app" : "Tablet"}</p>
          </div>
        </div>
        {decommissioned ? (
          <Badge variant="secondary">Decommissioned</Badge>
        ) : t.paired ? (
          <Badge className="bg-success text-success-foreground">Paired</Badge>
        ) : (
          <Badge variant="outline">Not paired</Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Last seen</dt>
          <dd title={t.last_seen_at ? formatDateTime(t.last_seen_at) : undefined}>{formatRelative(t.last_seen_at)}</dd>
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-xs leading-5">{value || <span className="text-muted-foreground font-sans">Not set</span>}</dd>
            </div>
          ))}
        </dl>
        {!decommissioned && (
          <div className="flex flex-wrap gap-2">
            <Button variant={t.paired ? "outline" : "default"} onClick={onPair}>
              <Link2 />
              {t.paired ? "Pair a new device" : "Pair a device"}
            </Button>
            {t.paired && (
              <Button variant="outline" onClick={onUnpair}>
                <Link2Off />
                Unpair
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
