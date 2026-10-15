"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** A row of mutually exclusive buttons (restock/adjust, payment method) */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: ReactNode }[]
  disabled?: boolean
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("bg-muted inline-flex w-full rounded-lg p-1", className)}>
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-visible:ring-ring/50 flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] disabled:opacity-50",
              checked ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
