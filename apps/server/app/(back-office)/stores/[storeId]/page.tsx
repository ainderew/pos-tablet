import { redirect } from "next/navigation"

export default async function StoreHomePage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params
  redirect(`/stores/${storeId}/products`)
}
