import { CustomerLedgerView } from "@/components/customers/customer-ledger-view"

export const metadata = { title: "Customer ledger" }

export default async function CustomerPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params
  return <CustomerLedgerView customerId={customerId} />
}
