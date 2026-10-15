"use client"

import { useCallback, useEffect, useState } from "react"
import QRCode from "qrcode"
import { Clock, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FormError } from "@/components/forms/form-field"
import { api, errorMessage } from "@/lib/api-client"
import type { PairingCode, Terminal } from "@/lib/api-client"
import { cn } from "@/lib/utils"

const POLL_MS = 4000
/** Codes last 10 minutes (docs/api.md); caps the countdown when this device's clock runs behind */
const CODE_LIFETIME_MS = 10 * 60 * 1000

/** "9:05" */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** The QR as an image the browser draws itself (an SVG data URI: no canvas, nothing sent anywhere) */
export async function qrImage(payload: string): Promise<string> {
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function serverOf(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { server?: unknown }
    return typeof parsed.server === "string" ? parsed.server : null
  } catch {
    return null
  }
}

interface PairingDialogProps {
  terminal: Terminal | null
  onOpenChange: (open: boolean) => void
  /** The terminal went from unpaired to paired while the code was showing */
  onPaired: () => void
}

export function PairingDialog({ terminal, onOpenChange, onPaired }: PairingDialogProps) {
  const [pairing, setPairing] = useState<(PairingCode & { image: string; deadline: number }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const terminalId = terminal?.id ?? null
  const wasPaired = terminal?.paired ?? false

  const requestCode = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const code = await api.post<PairingCode>(`/api/terminals/${id}/pairing-code`)
      const received = Date.now()
      const deadline = received + Math.min(Math.max(new Date(code.expires_at).getTime() - received, 0), CODE_LIFETIME_MS)
      setPairing({ ...code, image: await qrImage(code.qr_payload), deadline })
      setNow(Date.now())
    } catch (e) {
      setPairing(null)
      setError(errorMessage(e, "Couldn't create a pairing code"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setPairing(null)
    setError(null)
    if (terminalId) void requestCode(terminalId)
  }, [terminalId, requestCode])

  const remaining = pairing ? pairing.deadline - now : 0
  const expired = !!pairing && remaining <= 0

  // The countdown
  useEffect(() => {
    if (!pairing || expired) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing, expired])

  // Notice when the tablet has paired, so the owner isn't left staring at a used code
  useEffect(() => {
    if (!terminal || wasPaired || !pairing || expired) return
    const timer = setInterval(async () => {
      try {
        const { terminals } = await api.get<{ terminals: Terminal[] }>(`/api/stores/${terminal.store_id}/terminals`)
        if (terminals.find((t) => t.id === terminal.id)?.paired) {
          toast.success(`${terminal.name} is paired`)
          onPaired()
        }
      } catch {
        // Keep showing the code; the list refreshes when the dialog closes
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [terminal, wasPaired, pairing, expired, onPaired])

  const server = pairing ? serverOf(pairing.qr_payload) : null

  return (
    <Dialog open={!!terminal} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pair a device with {terminal?.name}</DialogTitle>
          <DialogDescription>On the tablet, open the app&apos;s pairing screen and scan this code, or type the code.</DialogDescription>
        </DialogHeader>

        {wasPaired && <p className="bg-muted rounded-lg px-3 py-2 text-sm">A device is already paired with this terminal. Pairing another one signs that device out: one device per terminal.</p>}

        {error ? (
          <FormError message={error} />
        ) : !pairing ? (
          <div className="text-muted-foreground flex h-64 items-center justify-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin" />
            Creating a code…
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <div className={cn("relative rounded-xl border bg-white p-3", expired && "opacity-20")}>
              <img src={pairing.image} alt={`Pairing QR code for ${terminal?.name}`} width={224} height={224} className="size-56" />
            </div>
            <div className="grid justify-items-center gap-1">
              <p className="font-mono text-3xl font-bold tracking-[0.2em]" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
                {pairing.code}
              </p>
              {server && <p className="text-muted-foreground text-xs break-all">Server: {server}</p>}
            </div>
            <p className={cn("flex items-center gap-1.5 text-sm", expired ? "text-destructive font-medium" : "text-muted-foreground")} role="timer" aria-live="off">
              <Clock className="size-4" />
              {expired ? "This code has expired" : `Expires in ${formatCountdown(remaining)}`}
            </p>
          </div>
        )}

        <DialogFooter>
          {terminal && (expired || error) && (
            <Button variant="outline" onClick={() => void requestCode(terminal.id)} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              New code
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
