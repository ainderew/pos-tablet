"use client"

import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { ImportReport } from "@/lib/api-client"

/** What POST /api/products/import did, row by row for the problems */
export function ImportReportDialog({ report, fileName, onClose }: { report: ImportReport | null; fileName: string; onClose: () => void }) {
  const errors = report?.errors ?? []
  return (
    <Dialog open={!!report} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {errors.length ? <AlertTriangle className="text-warning size-5" /> : <CheckCircle2 className="text-success size-5" />}
            Import finished
          </DialogTitle>
          <DialogDescription>{fileName}</DialogDescription>
        </DialogHeader>
        {report && (
          <div className="grid gap-4">
            <dl className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ["Created", report.created],
                  ["Updated", report.updated],
                  ["Skipped", report.skipped],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="rounded-lg border p-3">
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="text-2xl font-bold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {errors.length > 0 && (
              <div className="grid gap-2">
                <p className="text-sm font-medium">
                  {errors.length} {errors.length === 1 ? "row wasn't" : "rows weren't"} imported
                </p>
                <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
                  {errors.map((e, i) => (
                    <li key={`${e.row}-${i}`} className="flex gap-3 px-3 py-2">
                      <span className="text-muted-foreground shrink-0 tabular-nums">Row {e.row}</span>
                      <span className="break-words">{e.message}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">Fix these rows in the file and import it again: rows are matched by barcode, then by name, so the rest won't be duplicated.</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
