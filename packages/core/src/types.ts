// Domain types ported from POS-bir lib/types.ts (kept field-for-field so totals stay identical).
// Sync metadata will change in Phase 2 (store_id / terminal_id / device_seq).

export type UnitType = "QUANTITY" | "WEIGHT"
export type TaxCategory = "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED"
export type SupplierType = "WHOLESALER" | "WET_MARKET" | "DIRECT_DELIVERY"

export interface SyncMetadata {
  pos_id: string
  is_synced: boolean
}

export interface Product extends SyncMetadata {
  id: string
  name: string
  barcode: string | null
  selling_price: number
  cost_price: number
  stock_level: number
  unit_type: UnitType
  low_stock_threshold: number
  notify_low_stock: boolean
  category_id: string | null
  tax_category: TaxCategory
  supplier_type: SupplierType
  is_promo: boolean
  promo_price: number | null
  wholesale_price?: number | null
  wholesale_threshold?: number | null
  category_name?: string
  is_low_stock?: boolean
}

export interface CartItem {
  product: Product
  quantity: number
  active_price?: number // Calculated price (retail or wholesale)
}
