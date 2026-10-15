import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { BackOfficeShell } from "@/components/back-office/shell"
import { getBackOfficeUser } from "./_lib/current-user"

export default async function BackOfficeLayout({ children }: { children: ReactNode }) {
  const user = await getBackOfficeUser()
  if (!user) redirect("/login")
  return <BackOfficeShell user={{ id: user.id, org_id: user.org_id, full_name: user.full_name, role: user.role, email: user.email }}>{children}</BackOfficeShell>
}
