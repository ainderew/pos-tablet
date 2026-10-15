import { Badge } from "@/components/ui/badge"
import { formatMoney } from "@/components/common/format"
import type { CreditStatus } from "@/lib/api-client"
import { cn } from "@/lib/utils"

const STATUS_LABELS: Record<CreditStatus, string> = { ACTIVE: "Active", OVERDUE: "Overdue", BLOCKED: "Blocked" }

export function CreditStatusBadge({ status, className }: { status: CreditStatus; className?: string }) {
  return (
    <Badge
      variant={status === "BLOCKED" ? "destructive" : "outline"}
      className={cn(status === "OVERDUE" && "border-warning text-warning-foreground bg-warning/20", className)}
    >
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

/** Balance against the credit limit, with a bar like POS-bir's credit table */
export function CreditUsage({ balance, limit, className }: { balance: number; limit: number; className?: string }) {
  const usage = limit > 0 ? (balance / limit) * 100 : balance > 0 ? 100 : 0
  const bar = usage > 100 ? "bg-destructive" : usage > 75 ? "bg-warning" : "bg-success"
  return (
    <div className={cn("grid gap-1", className)}>
      <div className="flex flex-wrap items-baseline justify-end gap-x-2 sm:justify-between">
        <span className={cn("font-medium tabular-nums", balance > 0 ? "text-destructive" : balance < 0 ? "text-success" : "")}>{formatMoney(balance)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">of {formatMoney(limit)}</span>
      </div>
      <div className="bg-secondary hidden h-1.5 w-full overflow-hidden rounded-full sm:block" aria-hidden>
        <div className={cn("h-full", bar)} style={{ width: `${Math.max(0, Math.min(usage, 100))}%` }} />
      </div>
    </div>
  )
}
