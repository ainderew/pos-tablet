"use client"

import { useEffect, useState } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Search box that reports what was typed after a short pause */
export function SearchInput({ value, onChange, placeholder, className, delay = 300 }: { value: string; onChange: (value: string) => void; placeholder: string; className?: string; delay?: number }) {
  const [text, setText] = useState(value)

  useEffect(() => setText(value), [value])

  useEffect(() => {
    if (text === value) return
    const timer = setTimeout(() => onChange(text), delay)
    return () => clearTimeout(timer)
  }, [text, value, delay, onChange])

  return (
    <div className={cn("relative", className)}>
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="pr-9 pl-9" />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("")
            onChange("")
          }}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded p-1"
          aria-label="Clear search"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

