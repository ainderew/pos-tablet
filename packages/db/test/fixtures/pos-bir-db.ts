// Builds a realistic POS-bir pos.db for the importer tests, from POS-bir's own schema (./pos-bir-schema.sql,
// which also seeds the default Administrator and the settings). Every build gets fresh ids.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

export const POS_BIR_SCHEMA = readFileSync(new URL("./pos-bir-schema.sql", import.meta.url), "utf8")

// Real bcrypt hashes (cost 10, as POS-bir makes them) of the PINs 1111, 2222, 3333 and 4444
export const PIN_HASHES = {
  owner: "$2b$10$EpDyaoqr1EYeoJyj7A2v5.2syZ21PHZzomaw5Rq1cncI6DAG4IoCu",
  manager: "$2b$10$Bl9W1Pt7IEKm2VqI3YrJX.zFnurSQNIY2cF.lhiWoiaNejQDDLYAa",
  cashier: "$2b$10$p2vlan68tWTYdK/PgICg5.WgaA7Dd341f6qxYAHrIZ4Xzagi8TXVm",
  former: "$2b$10$EfjYmEbKIcEWUYgO69Dvgu5Jm9LPzhDGf0zw50XoG9bihI5NLBYLa",
}

type Value = string | number | null

export interface BuildOptions {
  /** A barcode an active product of the target organization already has */
  takenBarcode: string
  /** A barcode only a soft-deleted product of the target organization has */
  freedBarcode: string
  /** Leave the database open in WAL mode with its last writes not checkpointed */
  keepOpen?: boolean
}

export function buildPosBirDb(dir: string, options: BuildOptions) {
  const ids = {
    beverages: randomUUID(),
    grains: randomUUID(),
    snacks: randomUUID(),
    frozen: randomUUID(),
    coke: randomUUID(),
    rice: randomUUID(),
    canton: randomUUID(),
    bearBrand: randomUUID(),
    soap: randomUUID(),
    piattos: randomUUID(),
    cigarettes: randomUUID(),
    shampoo: randomUUID(),
    nena: randomUUID(),
    tonyo: randomUUID(),
    ben: randomUUID(),
    liza: randomUUID(),
    owner: randomUUID(),
    manager: randomUUID(),
    cashier: randomUUID(),
    former: randomUUID(),
    shift: randomUUID(),
    sale: randomUUID(),
  }
  const file = path.join(dir, "pos.db")
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL") // as POS-bir runs it
  if (options.keepOpen) db.exec("PRAGMA wal_autocheckpoint = 0")
  db.exec(POS_BIR_SCHEMA)
  const insert = (table: string, row: Record<string, Value>) => {
    const columns = Object.keys(row)
    db.prepare(`insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`).run(...Object.values(row))
  }
  const pos = { pos_id: "POS-01" }

  insert("categories", { id: ids.beverages, name: "Beverages", ...pos, created_at: "2026-02-01 08:00:00" })
  insert("categories", { id: ids.grains, name: "Rice & Grains", ...pos })
  insert("categories", { id: ids.snacks, name: "snacks", ...pos }) // the organization already has "Snacks"
  insert("categories", { id: ids.frozen, name: "Frozen", ...pos })

  const product = (id: string, row: Record<string, Value>) =>
    insert("products", { id, unit_type: "QUANTITY", stock_level: 0, ...pos, ...row })
  product(ids.coke, {
    name: "Coca-Cola 1.5L",
    barcode: "4801981116072",
    selling_price: 75,
    cost_price: 62.5,
    stock_level: 24,
    low_stock_threshold: 6,
    notify_low_stock: 1,
    category_id: ids.beverages,
    created_at: "2026-02-01 08:05:00",
  })
  product(ids.rice, {
    name: "Sinandomeng Rice (per kg)",
    selling_price: 52,
    cost_price: 45.333,
    stock_level: 37.6254,
    unit_type: "WEIGHT",
    low_stock_threshold: 5.5,
    notify_low_stock: 1,
    category_id: ids.grains,
    tax_category: "VAT_EXEMPT",
    supplier_type: "WET_MARKET",
  })
  product(ids.canton, {
    name: "Lucky Me Pancit Canton",
    barcode: "4807770270017",
    selling_price: 18,
    cost_price: 14.5,
    wholesale_price: 16.5,
    wholesale_threshold: 12,
    stock_level: 120,
    category_id: ids.snacks,
  })
  product(ids.bearBrand, { name: "Bear Brand 33g", barcode: "4800361002240", selling_price: 22, cost_price: 19, wholesale_price: 20, wholesale_threshold: 0 })
  product(ids.soap, { name: "Safeguard Soap", barcode: options.takenBarcode, selling_price: 45, cost_price: 38, stock_level: 10 })
  product(ids.piattos, { name: "Piattos", barcode: "4800016644788", selling_price: 17.5, cost_price: 13, is_promo: 1, promo_price: 15.999, stock_level: 30 })
  product(ids.cigarettes, { name: "Marlboro Red (stick)", selling_price: 9, cost_price: 7.25, stock_level: -2 })
  product(ids.shampoo, { name: "Palmolive Sachet", barcode: options.freedBarcode, selling_price: 8, cost_price: 6, stock_level: 48, tax_category: "ZERO_RATED" })

  const customer = (id: string, row: Record<string, Value>) => insert("customers", { id, ...pos, ...row })
  customer(ids.nena, { full_name: "Aling Nena", phone_number: "09171234567", address: "Purok 3", credit_limit: 2000, current_debt_balance: 1250.755 })
  customer(ids.tonyo, { full_name: "Mang Tonyo", credit_limit: 500, current_debt_balance: -150.5, email: "tonyo@example.com" })
  customer(ids.ben, { full_name: "Kuya Ben", credit_limit: 1000, current_debt_balance: 0, credit_status: "BLOCKED", email: "", address: "  " })
  customer(ids.liza, { full_name: "Ate Liza", credit_limit: 3000, current_debt_balance: 3000, credit_status: "OVERDUE" })

  const user = (id: string, row: Record<string, Value>) => insert("users", { id, ...row })
  user(ids.owner, { full_name: "Maria Santos", pin_hash: PIN_HASHES.owner, role: "OWNER" })
  user(ids.manager, { full_name: "Jose Rizal", pin_hash: PIN_HASHES.manager, role: "MANAGER" })
  user(ids.cashier, { full_name: "Ana Cruz", pin_hash: PIN_HASHES.cashier, role: "CASHIER", created_at: "2026-03-15 01:30:00" })
  user(ids.former, { full_name: "Ben Reyes", pin_hash: PIN_HASHES.former, role: "CASHIER", is_active: 0 })

  // A little history, which stays on the PC
  insert("shifts", { id: ids.shift, ...pos, user_id: ids.cashier, opening_fund: 1000 })
  insert("transactions", { id: ids.sale, invoice_number: "SI-000001", ...pos, gross_sales: 150, net_sales: 150, payment_method: "STORE_CREDIT" })
  insert("transaction_items", { id: randomUUID(), transaction_id: ids.sale, product_id: ids.coke, quantity_sold: 2, price_at_sale: 75, cost_at_sale: 62.5, tax_category: "VATABLE", ...pos })
  insert("credit_ledger", { id: randomUUID(), customer_id: ids.nena, transaction_id: ids.sale, entry_type: "CHARGE", amount: 150, running_balance: 1250.755 })

  if (options.keepOpen) return { file, ids, db }
  db.close()
  return { file, ids, db: null }
}
