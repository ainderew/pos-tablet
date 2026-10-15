import type { ReactNode } from "react"
import { StoreGate } from "@/components/back-office/store-gate"

export default async function StoreLayout({ children, params }: { children: ReactNode; params: Promise<{ storeId: string }> }) {
  const { storeId } = await params
  return <StoreGate storeId={storeId}>{children}</StoreGate>
}
