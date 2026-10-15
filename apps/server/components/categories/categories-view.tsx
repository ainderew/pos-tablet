"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, MoreHorizontal, Pencil, Tags, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states"
import { useBackOffice } from "@/components/back-office/back-office-context"
import { api, ApiError, errorMessage } from "@/lib/api-client"
import type { Category } from "@/lib/api-client"
import { CategoryNameForm } from "./category-name-form"

export function CategoriesView() {
  const { currentStoreId } = useBackOffice()
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Category | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const { categories } = await api.get<{ categories: Category[] }>("/api/categories")
      setCategories([...categories].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) {
      setLoadError(errorMessage(e, "Couldn't load the categories"))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async () => {
    if (!deleting) return
    await api.delete(`/api/categories/${deleting.id}`)
    toast.success(`${deleting.name} deleted`)
    void load()
  }

  return (
    <div className="grid gap-5">
      <PageHeader title="Categories" description="Shared by every store's catalog" />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Add a category</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryNameForm onSaved={() => void load()} />
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        {loadError && !categories ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : !categories ? (
          <LoadingState />
        ) : categories.length === 0 ? (
          <EmptyState icon={Tags} title="No categories yet" description="Categories group products on the tablet and in reports." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="text-right">Products</TableHead>
                <TableHead className="w-10 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4 font-medium whitespace-normal">{c.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {currentStoreId && (c.product_count ?? 0) > 0 ? (
                      <Link className="underline-offset-4 hover:underline" href={`/stores/${currentStoreId}/products?category=${c.id}`}>
                        {c.product_count}
                      </Link>
                    ) : (
                      (c.product_count ?? "—")
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setRenaming(c)}>
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
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
        )}
      </Card>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename category</DialogTitle>
            <DialogDescription>Products keep their category; only the name changes.</DialogDescription>
          </DialogHeader>
          {renaming && (
            <CategoryNameForm
              key={renaming.id}
              category={renaming}
              onCancel={() => setRenaming(null)}
              onSaved={() => {
                setRenaming(null)
                void load()
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "category"}?`}
        description="Only a category that no active product uses can be deleted."
        confirmLabel="Delete category"
        destructive
        onConfirm={remove}
        renderError={(error) => (deleting ? <CategoryDeleteError error={error} category={deleting} storeId={currentStoreId} /> : null)}
      />
    </div>
  )
}

/** CATEGORY_IN_USE explained, with a way to the products in question */
export function CategoryDeleteError({ error, category, storeId }: { error: unknown; category: Category; storeId: string | null }) {
  if (!(error instanceof ApiError) || error.code !== "CATEGORY_IN_USE") return null
  const count = category.product_count
  return (
    <Alert className="border-warning/50">
      <AlertTriangle className="text-warning" />
      <AlertTitle>{category.name} is still in use</AlertTitle>
      <AlertDescription>
        <p>
          {count ? `${count} active ${count === 1 ? "product uses" : "products use"} it.` : "Active products still use it."} Move them to another category (or delete them), then try again.
        </p>
        {storeId && (
          <Button asChild variant="outline" size="sm" className="mt-1">
            <Link href={`/stores/${storeId}/products?category=${category.id}`}>See those products</Link>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
