import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthCard } from "@/components/auth/auth-card"
import { SetupForm } from "@/components/auth/setup-form"
import { getBackOfficeUser } from "@/app/(back-office)/_lib/current-user"

export const metadata = { title: "First-time setup" }

// Only for someone arriving without a session; the server itself refuses once any user exists
export default async function SetupPage() {
  if (await getBackOfficeUser()) redirect("/stores")
  return (
    <AuthCard
      wide
      title="First-time setup"
      description="Create your business, its first store and the owner account. This works once, on a new server."
      footer={
        <>
          Already set up?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SetupForm />
    </AuthCard>
  )
}
