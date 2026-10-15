"use client"

import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Option<T extends string> {
  value: T
  title: ReactNode
  description?: ReactNode
}

/** A choice between a few options, each with an explanation (a radio group drawn as cards) */
export function OptionCards<T extends string>({
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
  options: readonly Option<T>[]
  disabled?: boolean
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-2", className)}>
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
              "focus-visible:ring-ring/50 flex items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-60",
              checked ? "border-primary bg-accent/60" : "hover:bg-accent/40"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
              )}
            >
              {checked && <Check className="size-3" />}
            </span>
            <span className="grid gap-1">
              <span className="font-medium">{option.title}</span>
              {option.description && <span className="text-muted-foreground leading-snug">{option.description}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
