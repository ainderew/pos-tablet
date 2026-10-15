"use client"

import { useMemo } from "react"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { FormError, FormField } from "@/components/forms/form-field"
import { COUNT, MAX_QUANTITY, MONEY, numberInput, numberText, optionalNumberInput, optionalText, requiredText } from "@/components/forms/fields"
import { showServerError } from "@/components/forms/server-errors"
import { zodResolver } from "@/components/forms/zod-resolver"
import { api, errorMessage } from "@/lib/api-client"
import type { Category, Product, StockMovement, SupplierType, TaxCategory, UnitType } from "@/lib/api-client"

const NO_CATEGORY = "__none__"

export const UNIT_TYPES: readonly { value: UnitType; label: string }[] = [
  { value: "QUANTITY", label: "By the piece" },
  { value: "WEIGHT", label: "By weight (kg)" },
]

export const TAX_CATEGORIES: readonly { value: TaxCategory; label: string }[] = [
  { value: "VATABLE", label: "VATable (12% VAT)" },
  { value: "VAT_EXEMPT", label: "VAT-exempt" },
  { value: "ZERO_RATED", label: "Zero-rated" },
]

export const SUPPLIER_TYPES: readonly { value: SupplierType; label: string }[] = [
  { value: "WHOLESALER", label: "Wholesaler" },
  { value: "WET_MARKET", label: "Wet market" },
  { value: "DIRECT_DELIVERY", label: "Direct delivery" },
]

// The server's product rules (docs/api.md, lib/catalog/products.ts): prices ≥ 0 with 2 decimals;
// the wholesale price (above 0) and minimum quantity (1 or more) set together or not at all;
// thresholds are whole numbers. Requiring a promo price for a product on promo is the form's own rule.
export const productSchema = z
  .object({
    name: requiredText("Enter the product name", 200),
    barcode: optionalText(64),
    category_id: z.string().transform((v) => (v && v !== NO_CATEGORY ? v : null)),
    unit_type: z.enum(["QUANTITY", "WEIGHT"]),
    tax_category: z.enum(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]),
    supplier_type: z.enum(["WHOLESALER", "WET_MARKET", "DIRECT_DELIVERY"]),
    cost_price: numberInput("Enter the cost price", MONEY),
    selling_price: numberInput("Enter the selling price", MONEY),
    low_stock_threshold: optionalNumberInput(COUNT).transform((v) => v ?? 0),
    notify_low_stock: z.boolean(),
    wholesale_threshold: optionalNumberInput({ ...COUNT, greaterThan: 0 }),
    wholesale_price: optionalNumberInput({ ...MONEY, greaterThan: 0 }),
    is_promo: z.boolean(),
    promo_price: optionalNumberInput(MONEY),
    /** New products only: the first restock at the selected store */
    opening_stock: optionalNumberInput({ decimals: 3, greaterThan: 0, max: MAX_QUANTITY }),
  })
  .superRefine((v, ctx) => {
    // (A field that failed its own check still holds the typed text here)
    if (v.wholesale_price !== null && v.wholesale_threshold === null) {
      ctx.addIssue({ code: "custom", path: ["wholesale_threshold"], message: "Set the minimum quantity too, or clear the wholesale price" })
    }
    if (v.wholesale_threshold !== null && v.wholesale_price === null) {
      ctx.addIssue({ code: "custom", path: ["wholesale_price"], message: "Set the wholesale price too, or clear the minimum quantity" })
    }
    if (v.is_promo && v.promo_price === null) ctx.addIssue({ code: "custom", path: ["promo_price"], message: "Enter the promo price" })
    if (v.unit_type === "QUANTITY" && typeof v.opening_stock === "number" && !Number.isInteger(v.opening_stock)) {
      ctx.addIssue({ code: "custom", path: ["opening_stock"], message: "Sold by the piece: use a whole number" })
    }
  })

export type ProductFormInput = z.input<typeof productSchema>
type ProductFormOutput = z.output<typeof productSchema>

const FIELDS = [
  "name",
  "barcode",
  "category_id",
  "unit_type",
  "tax_category",
  "supplier_type",
  "cost_price",
  "selling_price",
  "low_stock_threshold",
  "notify_low_stock",
  "wholesale_threshold",
  "wholesale_price",
  "is_promo",
  "promo_price",
] as const

function defaults(product?: Product): ProductFormInput {
  return {
    name: product?.name ?? "",
    barcode: product?.barcode ?? "",
    category_id: product?.category_id ?? NO_CATEGORY,
    unit_type: product?.unit_type ?? "QUANTITY",
    tax_category: product?.tax_category ?? "VATABLE",
    supplier_type: product?.supplier_type ?? "WHOLESALER",
    cost_price: numberText(product?.cost_price),
    selling_price: numberText(product?.selling_price),
    low_stock_threshold: product ? numberText(product.low_stock_threshold) : "",
    notify_low_stock: product?.notify_low_stock ?? false,
    // A product without wholesale pricing has no price (and threshold 0 in the database)
    wholesale_threshold: product?.wholesale_price != null && product.wholesale_threshold ? String(product.wholesale_threshold) : "",
    wholesale_price: product?.wholesale_price != null && product.wholesale_threshold ? String(product.wholesale_price) : "",
    is_promo: product?.is_promo ?? false,
    promo_price: numberText(product?.promo_price),
    opening_stock: "",
  }
}

/** The body for POST /api/products and PATCH /api/products/:id ("no wholesale" is threshold 0) */
export function productBody(values: ProductFormOutput) {
  const { opening_stock: _, ...body } = values
  return { ...body, wholesale_threshold: body.wholesale_threshold ?? 0 }
}

interface ProductFormProps {
  product?: Product
  categories: Category[]
  /** Where an opening stock for a new product goes */
  store: { id: string; name: string }
  onSaved: (product: Product) => void
  onCancel: () => void
}

export function ProductForm({ product, categories, store, onSaved, onCancel }: ProductFormProps) {
  const form = useForm<ProductFormInput, unknown, ProductFormOutput>({
    resolver: zodResolver(productSchema),
    defaultValues: useMemo(() => defaults(product), [product]),
  })
  const { errors, isSubmitting } = form.formState
  const unitType = form.watch("unit_type")
  const isPromo = form.watch("is_promo")
  const unit = unitType === "WEIGHT" ? "kg" : "pcs"

  const submit = form.handleSubmit(async (values) => {
    let saved: Product
    try {
      const body = productBody(values)
      saved = product
        ? (await api.patch<{ product: Product }>(`/api/products/${product.id}`, body)).product
        : (await api.post<{ product: Product }>("/api/products", body)).product
    } catch (error) {
      showServerError(error, form.setError, { fields: FIELDS, codes: { DUPLICATE_BARCODE: "barcode" } })
      return
    }

    if (!product && values.opening_stock) {
      try {
        await api.post<{ movement: StockMovement; stock_level: number }>(`/api/stores/${store.id}/stock-movements`, {
          product_id: saved.id,
          quantity_delta: values.opening_stock,
          reason: "RESTOCK",
          note: "Opening stock",
        })
      } catch (error) {
        toast.warning(`${saved.name} was added, but its opening stock wasn't saved: ${errorMessage(error)}. Use “Stock” on the product to add it.`)
      }
    }
    toast.success(product ? `${saved.name} updated` : `${saved.name} added`)
    onSaved(saved)
  })

  const field = (name: keyof ProductFormInput) => ({ id: `product-${name}`, "aria-invalid": !!errors[name] })

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <div className="grid gap-4">
        <FormField label="Product name" htmlFor="product-name" error={errors.name?.message}>
          <Input {...field("name")} autoFocus={!product} {...form.register("name")} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Barcode" htmlFor="product-barcode" optional error={errors.barcode?.message} hint="Scan it into this box, or type it">
            <Input {...field("barcode")} autoComplete="off" {...form.register("barcode")} />
          </FormField>
          <FormField label="Category" htmlFor="product-category_id" error={errors.category_id?.message}>
            <Controller
              control={form.control}
              name="category_id"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="product-category_id" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Sold" htmlFor="product-unit_type">
            <Controller
              control={form.control}
              name="unit_type"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="product-unit_type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNIT_TYPES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
          <FormField label="Tax" htmlFor="product-tax_category">
            <Controller
              control={form.control}
              name="tax_category"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="product-tax_category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_CATEGORIES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
          <FormField label="Supplier" htmlFor="product-supplier_type">
            <Controller
              control={form.control}
              name="supplier_type"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="product-supplier_type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPLIER_TYPES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField label={`Cost price (₱${unitType === "WEIGHT" ? "/kg" : ""})`} htmlFor="product-cost_price" error={errors.cost_price?.message}>
            <Input {...field("cost_price")} inputMode="decimal" placeholder="0.00" {...form.register("cost_price")} />
          </FormField>
          <FormField label={`Selling price (₱${unitType === "WEIGHT" ? "/kg" : ""})`} htmlFor="product-selling_price" error={errors.selling_price?.message}>
            <Input {...field("selling_price")} inputMode="decimal" placeholder="0.00" {...form.register("selling_price")} />
          </FormField>
        </div>
      </div>

      <Separator />

      <section className="grid gap-4" aria-labelledby="product-stock-heading">
        <h3 id="product-stock-heading" className="text-sm font-semibold">
          Stock alerts
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {!product && (
            <FormField label={`Opening stock at ${store.name} (${unit})`} htmlFor="product-opening_stock" optional error={errors.opening_stock?.message} hint="Recorded as a restock">
              <Input {...field("opening_stock")} inputMode="decimal" placeholder="0" {...form.register("opening_stock")} />
            </FormField>
          )}
          <FormField label={`Low-stock level (${unit})`} htmlFor="product-low_stock_threshold" error={errors.low_stock_threshold?.message} hint="Whole number; 0 for none">
            <Input {...field("low_stock_threshold")} inputMode="numeric" placeholder="0" {...form.register("low_stock_threshold")} />
          </FormField>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="grid gap-0.5">
            <Label htmlFor="product-notify_low_stock">Low-stock alerts</Label>
            <p className="text-muted-foreground text-xs">Flag the product when its stock falls below the low-stock level</p>
          </div>
          <Controller
            control={form.control}
            name="notify_low_stock"
            render={({ field: f }) => <Switch id="product-notify_low_stock" checked={f.value} onCheckedChange={f.onChange} />}
          />
        </div>
      </section>

      <Separator />

      <section className="grid gap-4" aria-labelledby="product-wholesale-heading">
        <div>
          <h3 id="product-wholesale-heading" className="text-sm font-semibold">
            Wholesale pricing
          </h3>
          <p className="text-muted-foreground text-xs">Optional: a lower price when a customer buys at least this many. Fill in both, or neither.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField label={`Minimum quantity (${unit})`} htmlFor="product-wholesale_threshold" error={errors.wholesale_threshold?.message}>
            <Input {...field("wholesale_threshold")} inputMode="numeric" placeholder="e.g. 12" {...form.register("wholesale_threshold")} />
          </FormField>
          <FormField label="Wholesale price (₱)" htmlFor="product-wholesale_price" error={errors.wholesale_price?.message}>
            <Input {...field("wholesale_price")} inputMode="decimal" placeholder="0.00" {...form.register("wholesale_price")} />
          </FormField>
        </div>
      </section>

      <Separator />

      <section className="grid gap-4 sm:grid-cols-2 sm:items-start" aria-labelledby="product-promo-heading">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="grid gap-0.5">
            <Label id="product-promo-heading" htmlFor="product-is_promo">
              On promo
            </Label>
            <p className="text-muted-foreground text-xs">Sell at the promo price instead of the selling price</p>
          </div>
          <Controller control={form.control} name="is_promo" render={({ field: f }) => <Switch id="product-is_promo" checked={f.value} onCheckedChange={f.onChange} />} />
        </div>
        <FormField label="Promo price (₱)" htmlFor="product-promo_price" optional={!isPromo} error={errors.promo_price?.message}>
          <Input {...field("promo_price")} inputMode="decimal" placeholder="0.00" {...form.register("promo_price")} />
        </FormField>
      </section>

      <FormError message={errors.root?.server?.message} />

      <div className="bg-background sticky bottom-0 -mx-6 -mb-6 flex flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {product ? "Save changes" : "Add product"}
        </Button>
      </div>
    </form>
  )
}
