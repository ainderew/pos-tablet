import type { ReactNode } from "react"
import type { Metadata, Viewport } from "next"
import { Toaster } from "@/components/toaster"
import "./globals.css"

export const metadata: Metadata = {
  title: { default: "General Store POS", template: "%s · General Store POS" },
  description: "Back office and sync server",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
