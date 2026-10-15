import { redirect } from "next/navigation"

// Into the back office; its layout sends signed-out visitors to /login
export default function HomePage() {
  redirect("/stores")
}
