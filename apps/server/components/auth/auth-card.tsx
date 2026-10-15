import type { ReactNode } from "react"
import { Store } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** The centered card the sign-in and setup pages share */
export function AuthCard({ title, description, children, footer, wide }: { title: string; description: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <main className="bg-workspace flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className={wide ? "w-full max-w-lg" : "w-full max-w-sm"}>
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
            <Store className="size-5" />
          </div>
          <span className="text-lg font-semibold">General Store POS</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {footer && <div className="text-muted-foreground mt-4 text-center text-sm">{footer}</div>}
      </div>
    </main>
  )
}
