// Server-owned catalog and customers (edited in the back office, synced down to terminals)
import { sql } from "drizzle-orm"
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { money, versioned } from "./columns"
import { organizations, stores } from "./tenancy"

export const categories = pgTable(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    org_id: uuid()
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    ...versioned,
  },
  (t) => [uniqueIndex("categories_name_idx").on(t.org_id, sql`lower(${t.name})`).where(sql`${t.deleted_at} is null`)]
)

/** Products are shared by an organization's stores; stock is per store (sum of stock_movements) */
export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    org_id: uuid()
      .notNull()
      .references(() => organizations.id),
    category_id: uuid().references(() => categories.id),
    name: text().notNull(),
    barcode: text(),
    selling_price: money().notNull(),
    cost_price: money().notNull(),
    unit_type: text().notNull(),
    tax_category: text().notNull().default("VATABLE"),
    supplier_type: text().notNull().default("WHOLESALER"),
    wholesale_price: money(),
    wholesale_threshold: integer().notNull().default(0),
    low_stock_threshold: integer().notNull().default(0),
    notify_low_stock: boolean().notNull().default(false),
    is_promo: boolean().notNull().default(false),
    promo_price: money(),
    ...versioned,
  },
  (t) => [
    index("products_org_idx").on(t.org_id),
    uniqueIndex("products_barcode_idx").on(t.org_id, t.barcode).where(sql`${t.barcode} is not null and ${t.deleted_at} is null`),
    check("products_unit_type_check", sql`${t.unit_type} in ('QUANTITY', 'WEIGHT')`),
    check("products_tax_category_check", sql`${t.tax_category} in ('VATABLE', 'VAT_EXEMPT', 'ZERO_RATED')`),
    check("products_prices_check", sql`${t.selling_price} >= 0 and ${t.cost_price} >= 0`),
  ]
)

/** Store-credit customers belong to one store; their balance is the sum of credit_ledger entries */
export const customers = pgTable(
  "customers",
  {
    id: uuid().primaryKey().defaultRandom(),
    store_id: uuid()
      .notNull()
      .references(() => stores.id),
    full_name: text().notNull(),
    phone_number: text(),
    email: text(),
    address: text(),
    credit_limit: money().notNull().default(0),
    credit_status: text().notNull().default("ACTIVE"),
    ...versioned,
  },
  (t) => [
    index("customers_store_idx").on(t.store_id),
    check("customers_credit_status_check", sql`${t.credit_status} in ('ACTIVE', 'BLOCKED', 'OVERDUE')`),
  ]
)
