import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthCard } from "@/components/auth/auth-card"
import { LoginForm } from "@/components/auth/login-form"
import { getBackOfficeUser } from "@/app/(back-office)/_lib/current-user"

export const metadata = { title: "Sign in" }

export default async function LoginPage() {
  if (await getBackOfficeUser()) redirect("/stores")
  return (
    <AuthCard
      title="Sign in"
      description="Owners, admins and managers. Cashiers sign in on the tablet with their PIN."
      footer={
        <>
          New server?{" "}
          <Link href="/setup" className="text-foreground underline-offset-4 hover:underline">
            Run first-time setup
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthCard>
  )
}
