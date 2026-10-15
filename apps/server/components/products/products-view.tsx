"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Boxes, Download, FileSpreadsheet, Loader2, MoreHorizontal, Package, Pencil, Plus, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { formatMoney, formatQuantity } from "@/components/common/format"
import { PageHeader } from "@/components/common/page-header"
import { SearchInput } from "@/components/common/search-input"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useCurrentStore } from "@/components/back-office/back-office-context"
import { api, errorMessage, isAbort } from "@/lib/api-client"
import type { Category, ImportReport, Product } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { ImportReportDialog } from "./import-report-dialog"
import { ProductForm } from "./product-form"
import { StockDialog } from "./stock-dialog"

const ALL = "all"
type StockFilter = "all" | "low" | "out"

const isOut = (p: Product) => Number(p.stock_level ?? 0) <= 0
const isLow = (p: Product) => !isOut(p) && !!p.is_low_stock

export function ProductsView({ initialCategoryId }: { initialCategoryId?: string }) {
  const store = useCurrentStore()
  const [search, setSearch] = useState("")
  const [categoryId, setCategoryId] = useState(initialCategoryId ?? ALL)
  const [stockFilter, setStockFilter] = useState<StockFilter>("all")
  const [products, setProducts] = useState<Product[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [categories, setCategories] = useState<Category[]>([])

  const [editing, setEditing] = useState<Product | "new" | null>(null)
  const [stockProduct, setStockProduct] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importResult, setImportResult] = useState<{ report: ImportReport; fileName: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => setReloadKey((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    api
      .get<{ products: Product[] }>("/api/products", {
        query: { store_id: store.id, search: search.trim(), category_id: categoryId === ALL ? undefined : categoryId },
        signal: controller.signal,
      })
      .then(({ products }) => setProducts(products))
      .catch((e) => !isAbort(e) && setLoadError(errorMessage(e, "Couldn't load the products")))
      .finally(() => !controller.signal.aborted && setLoading(false))
    return () => controller.abort()
  }, [store.id, search, categoryId, reloadKey])

  const loadCategories = useCallback(async () => {
    try {
      const { categories } = await api.get<{ categories: Category[] }>("/api/categories")
      setCategories([...categories].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't load the categories"))
    }
  }, [])

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  const categoryNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])
  const visible = useMemo(() => {
    const list = products ?? []
    if (stockFilter === "out") return list.filter(isOut)
    if (stockFilter === "low") return list.filter(isLow)
    return list
  }, [products, stockFilter])
  const counts = useMemo(() => ({ total: products?.length ?? 0, out: products?.filter(isOut).length ?? 0, low: products?.filter(isLow).length ?? 0 }), [products])

  const exportCsv = async () => {
    setExporting(true)
    try {
      // With store_id the file carries this store's stock, and imports back into it
      const { blob, filename } = await api.download("/api/products/export", { query: { store_id: store.id } })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename ?? `products-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't export the products"))
    } finally {
      setExporting(false)
    }
  }

  const importCsv = async (file: File) => {
    setImporting(true)
    try {
      const body = new FormData()
      body.append("file", file)
      const report = await api.post<ImportReport>("/api/products/import", body, { query: { store_id: store.id } })
      setImportResult({ report, fileName: file.name })
      reload()
      void loadCategories()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't import the file"))
    } finally {
      setImporting(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const deleteProduct = async () => {
    if (!deleting) return
    await api.delete(`/api/products/${deleting.id}`)
    toast.success(`${deleting.name} deleted`)
    reload()
  }

  const filtering = !!search.trim() || categoryId !== ALL || stockFilter !== "all"

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Products"
        description={`The catalog every store shares, with stock at ${store.name}`}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={importing || exporting}>
                  {importing || exporting ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                  CSV
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-muted-foreground max-w-64 text-xs font-normal">POS-bir&apos;s product CSV. Its stock_level column is the stock at {store.name}.</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void exportCsv()}>
                  <Download />
                  Export the catalog
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  <Upload />
                  Import a CSV file…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              aria-label="CSV file to import"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void importCsv(file)
              }}
            />
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add product
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <StatButton label="Products" value={counts.total} icon={Package} active={stockFilter === "all"} onClick={() => setStockFilter("all")} />
        <StatButton label="Low stock" value={counts.low} icon={AlertTriangle} tone="warning" active={stockFilter === "low"} onClick={() => setStockFilter(stockFilter === "low" ? "all" : "low")} />
        <StatButton label="Out of stock" value={counts.out} icon={Boxes} tone="destructive" active={stockFilter === "out"} onClick={() => setStockFilter(stockFilter === "out" ? "all" : "out")} />
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-2 border-b p-3 sm:flex-row">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name or barcode" className="flex-1" />
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                {categoryId !== ALL && !categoryNames.has(categoryId) && <SelectItem value={categoryId}>Selected category</SelectItem>}
              </SelectContent>
            </Select>
            <Select value={stockFilter} onValueChange={(v) => setStockFilter(v as StockFilter)}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Stock">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any stock</SelectItem>
                <SelectItem value="low">Low stock</SelectItem>
                <SelectItem value="out">Out of stock</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <CardContent className="px-0">
          {loadError && !products ? (
            <ErrorState message={loadError} onRetry={reload} />
          ) : !products ? (
            <LoadingState />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Package}
              title={filtering ? "No products match" : "No products yet"}
              description={filtering ? "Try another search or filter." : "Add your first product, or import your catalog from a CSV file."}
              action={
                !filtering && (
                  <Button onClick={() => setEditing("new")}>
                    <Plus />
                    Add product
                  </Button>
                )
              }
            />
          ) : (
            <div className={cn("transition-opacity", loading && "opacity-60")}>
              {loadError && <p className="text-destructive px-4 pt-3 text-sm">{loadError}</p>}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Product</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Cost</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="w-10 pr-4">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-[11rem] pl-4 whitespace-normal sm:max-w-none">
                        <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing(p)}>
                          {p.name}
                        </button>
                        <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                          {p.barcode && <span className="font-mono">{p.barcode}</span>}
                          <span className="md:hidden">{p.category_id ? categoryNames.get(p.category_id) : null}</span>
                          {p.is_promo && <span className="text-success">Promo</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden md:table-cell">{p.category_id ? (categoryNames.get(p.category_id) ?? "—") : "—"}</TableCell>
                      <TableCell className="text-right">
                        <div className={cn("font-medium tabular-nums", isOut(p) && "text-destructive", isLow(p) && "text-warning")}>{formatQuantity(p.stock_level, p.unit_type)}</div>
                        {isOut(p) ? (
                          <Badge variant="destructive" className="mt-0.5">
                            Out
                          </Badge>
                        ) : isLow(p) ? (
                          <Badge className="bg-warning text-warning-foreground mt-0.5">Low</Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">{formatMoney(p.cost_price)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.is_promo && p.promo_price != null ? (
                          <>
                            <div className="text-success font-medium">{formatMoney(p.promo_price)}</div>
                            <div className="text-muted-foreground text-xs line-through">{formatMoney(p.selling_price)}</div>
                          </>
                        ) : (
                          formatMoney(p.selling_price)
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${p.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel className="max-w-56 truncate">{p.name}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setStockProduct(p)}>
                              <Boxes />
                              Restock or adjust
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setEditing(p)}>
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}>
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "Add a product" : "Edit product"}</DialogTitle>
            <DialogDescription>{editing === "new" ? "It's added to the catalog of every store." : "Changes apply in every store and reach the terminals at their next sync."}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <ProductForm
              key={editing === "new" ? "new" : editing.id}
              product={editing === "new" ? undefined : editing}
              categories={categories}
              store={store}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                reload()
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <StockDialog
        product={stockProduct}
        store={store}
        onOpenChange={(open) => !open && setStockProduct(null)}
        onChanged={(productId, stockLevel) => {
          setProducts((list) => list?.map((p) => (p.id === productId ? { ...p, stock_level: stockLevel } : p)) ?? null)
          reload()
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "product"}?`}
        description="It disappears from the catalog of every store and from the terminals at their next sync. Past sales keep it."
        confirmLabel="Delete product"
        destructive
        onConfirm={deleteProduct}
      />

      <ImportReportDialog report={importResult?.report ?? null} fileName={importResult?.fileName ?? ""} onClose={() => setImportResult(null)} />
    </div>
  )
}

function StatButton({
  label,
  value,
  icon: Icon,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number
  icon: typeof Package
  tone?: "warning" | "destructive"
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "bg-card focus-visible:ring-ring/50 flex flex-col gap-1 rounded-xl border p-3 text-left shadow-sm transition-colors outline-none focus-visible:ring-[3px] sm:p-4",
        active ? "border-primary" : "hover:bg-accent/40"
      )}
    >
      <span className="text-muted-foreground flex items-center justify-between gap-1 text-xs font-medium sm:text-sm">
        {label}
        <Icon className={cn("size-4 shrink-0", tone === "warning" && "text-warning", tone === "destructive" && "text-destructive")} />
      </span>
      <span className={cn("text-xl font-bold tabular-nums sm:text-2xl", tone === "warning" && value > 0 && "text-warning", tone === "destructive" && value > 0 && "text-destructive")}>{value}</span>
    </button>
  )
}
