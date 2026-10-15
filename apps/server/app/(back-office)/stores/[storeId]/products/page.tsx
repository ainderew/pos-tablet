import { ProductsView } from "@/components/products/products-view"

export const metadata = { title: "Products" }

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ category?: string | string[] }> }) {
  const { category } = await searchParams
  return <ProductsView initialCategoryId={typeof category === "string" ? category : undefined} />
}
