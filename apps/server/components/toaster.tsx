"use client"

import type { CSSProperties } from "react"
import { Toaster as Sonner } from "sonner"

// Same look as POS-bir's components/ui/sonner.tsx, without next-themes (the back office is light only)
export function Toaster() {
  return (
    <Sonner
      theme="light"
      position="top-center"
      richColors
      closeButton
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
    />
  )
}
