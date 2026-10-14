import type { ReactNode } from "react"

export const metadata = {
  title: "General Store POS",
  description: "Back office and sync server",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  )
}
