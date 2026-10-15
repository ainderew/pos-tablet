// Imports an existing PC store (POS-bir's SQLite pos.db) into the server database: the catalog into the
// organization, opening stock and the store-credit customers (with their opening balances) into one
// store, and the users with their PINs. Sales, shifts and Z-readings stay on the PC, which syncs its own
// history once it is paired as a terminal (docs/architecture.md, "PC app (POS-bir) path").
//
// - Everything is written in one transaction: any error, or a dry run, rolls the whole import back.
// - POS-bir's ids are kept, so the PC's records still point at the right rows when it syncs later,
//   and an import that already happened is detected (and refused).
// - The pos.db is never opened in place: it is copied (with the -wal POS-bir may have left) to a
//   temporary directory and read from there, read-only, with Node's built-in node:sqlite.
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { and, eq, inArray, isNotNull, isNull, TransactionRollbackError } from "drizzle-orm"
import type { Db } from "../client"
import { categories, creditLedger, customers, organizations, products, stockMovements, stores, USER_ROLES, userStores, users } from "../schema"
import type { UserRole } from "../schema"

/** POS-bir's schema seeds an "Administrator" with this id on every install, with PIN 1234 (this hash) */
export const POS_BIR_DEFAULT_ADMIN_ID = "00000000-0000-0000-0000-000000000001"
export const POS_BIR_DEFAULT_ADMIN_PIN_HASH = "$2b$10$tKWHEh7nlNKJKoRFBr6BXewNWkuZrEiUaeWUqNZJTQ0HdMCrMdv3K"
export const OPENING_STOCK_NOTE = "Opening stock imported from POS-bir"
export const OPENING_BALANCE_NOTE = "Opening balance imported from POS-bir"

export interface PosBirImportTarget {
  orgId: string
  /** Receives the opening stock and the customers; non-owner users get access to it */
  storeId: string
  /** An active OWNER or ADMIN of the organization: the opening entries are recorded as theirs */
  importedBy: string
}

export interface PosBirImportOptions {
  /** Run the whole import and report it, then roll it back */
  dryRun?: boolean
}

export type PosBirRowKind = "category" | "product" | "customer" | "user"

/** `id` is POS-bir's id for the row */
export interface PosBirImportIssue {
  kind: PosBirRowKind
  id: string
  reason: string
}

export interface PosBirImportReport {
  dryRun: boolean
  source: { businessName: string | null }
  categories: number
  products: number
  /** Opening-stock ADJUSTMENT movements (products with non-zero stock) */
  stockAdjustments: number
  customers: number
  /** Opening-balance ledger entries (customers with a non-zero balance) */
  openingBalances: number
  /** Sum of the opening balances: what the customers owe the store, net of credit in their favour */
  openingBalanceTotal: number
  users: number
  /** Rows not imported, or merged into an existing row, and why */
  skipped: PosBirImportIssue[]
  /** Rows imported with a change worth checking (rounded thresholds, dropped settings, ...) */
  warnings: PosBirImportIssue[]
  notes: string[]
}

/** A problem with the input or the target; nothing was written */
export class PosBirImportError extends Error {
  name = "PosBirImportError"
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Row = Record<string, unknown>

interface PosBirData {
  businessName: string | null
  categories: Row[]
  products: Row[]
  customers: Row[]
  users: Row[]
  /** Rows per history table that stays on the PC, by description */
  history: [string, number][]
}

const REQUIRED_TABLES = ["categories", "products", "customers", "users"]
const HISTORY_TABLES: [string, string][] = [
  ["transactions", "sales and credit notes"],
  ["shifts", "shifts"],
  ["daily_readings", "X/Z-readings"],
  ["cash_movements", "cash movements"],
  ["credit_ledger", "credit ledger entries"],
  ["voids", "line voids"],
  ["audit_logs", "audit log entries"],
  ["collection_logs", "collection notes"],
]
const TAX_CATEGORIES = ["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]
const SUPPLIER_TYPES = ["WHOLESALER", "WET_MARKET", "DIRECT_DELIVERY"]
const CREDIT_STATUSES = ["ACTIVE", "BLOCKED", "OVERDUE"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BCRYPT_RE = /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/
// Rows per INSERT (Postgres allows 65535 bind parameters per statement)
const CHUNK = 500

export async function importPosBir(
  db: Db,
  sqlitePath: string,
  target: PosBirImportTarget,
  opts: PosBirImportOptions = {}
): Promise<PosBirImportReport> {
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== "string" || !UUID_RE.test(value)) throw new PosBirImportError(`target.${name} must be a UUID`)
  }
  const source = readPosBir(sqlitePath)
  const dryRun = opts.dryRun === true
  let report: PosBirImportReport | undefined
  try {
    await db.transaction(async (tx) => {
      report = await write(tx, source, target, dryRun)
      if (dryRun) tx.rollback()
    })
  } catch (error) {
    if (!(dryRun && report && error instanceof TransactionRollbackError)) throw error
  }
  if (!report) throw new Error("import finished without a report")
  return report
}

// ---------------------------------------------------------------------------------------------------
// Reading pos.db

function readPosBir(sqlitePath: string): PosBirData {
  if (!existsSync(sqlitePath)) throw new PosBirImportError(`No such file: ${sqlitePath}`)
  // Opening the original would create -shm/-wal files next to it (and a read-only directory can't be
  // read at all); a copy also keeps a still-running POS-bir from changing the data mid-read
  const dir = mkdtempSync(path.join(tmpdir(), "pos-bir-import-"))
  try {
    const copy = path.join(dir, "pos.db")
    copyFileSync(sqlitePath, copy)
    // Committed writes POS-bir hadn't checkpointed yet (it runs in WAL mode); without it they're lost
    if (existsSync(`${sqlitePath}-wal`)) copyFileSync(`${sqlitePath}-wal`, `${copy}-wal`)
    let sqlite: DatabaseSync | undefined
    try {
      sqlite = new DatabaseSync(copy, { readOnly: true })
      const s = sqlite
      const tables = new Set(s.prepare("select name from sqlite_master where type = 'table'").all().map((r) => String(r.name)))
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
      if (missing.length > 0) throw new PosBirImportError(`${sqlitePath} is not a POS-bir database (no ${missing.join(", ")} table)`)
      const all = (table: string) => s.prepare(`select * from ${table} order by rowid`).all() as Row[]
      const setting = tables.has("settings")
        ? s.prepare("select value from settings where key = 'business_name'").get()
        : undefined
      return {
        businessName: text(setting?.value),
        categories: all("categories"),
        products: all("products"),
        customers: all("customers"),
        users: all("users"),
        history: HISTORY_TABLES.filter(([table]) => tables.has(table)).map(([table, label]) => [
          label,
          Number(s.prepare(`select count(*) as n from ${table}`).get()?.n ?? 0),
        ]),
      }
    } catch (error) {
      if (error instanceof PosBirImportError) throw error
      throw new PosBirImportError(`Could not read ${sqlitePath}: ${(error as Error).message}`)
    } finally {
      sqlite?.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Trimmed text, or null when missing or blank */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === "" ? null : s
}

/** A number, or NaN when missing or not numeric (SQLite columns can hold anything) */
function num(value: unknown): number {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return NaN
  return Number(value)
}

/** Half away from zero, like @pos/core's roundMoney: toPrecision(15) strips binary noise first. NaN stays NaN. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  const scaled = Number((Math.abs(value) * factor).toPrecision(15))
  const rounded = (Math.sign(value) * Math.round(scaled)) / factor
  return rounded === 0 ? 0 : rounded // no -0
}
const money = (value: number) => round(value, 2)
const quantity = (value: number) => round(value, 3)

/** SQLite's datetime('now') text is UTC without a zone ("2026-01-28 09:15:00") */
function timestamp(value: unknown): Date | undefined {
  const s = text(value)
  if (!s) return undefined
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** "1"/"true" (or a JS true) as stored by POS-bir's boolean columns */
function flag(value: unknown): boolean {
  return value === true || num(value) > 0 || String(value).trim().toLowerCase() === "true"
}

/**
 * The server id for a POS-bir row: POS-bir's own id (it generates UUIDs). Ids that can repeat across
 * installs (the seeded Administrator's, or any id that isn't a UUID) get a UUID derived from it and the
 * target store instead, so another PC's import doesn't collide and the same import is still detected.
 */
function serverId(kind: PosBirRowKind, raw: string, target: PosBirImportTarget): string {
  const lower = raw.toLowerCase()
  if (UUID_RE.test(raw) && !(kind === "user" && lower === POS_BIR_DEFAULT_ADMIN_ID)) return lower
  const h = createHash("sha1").update(`pos-bir:${target.storeId}:${kind}:${raw}`).digest("hex")
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ---------------------------------------------------------------------------------------------------
// Writing

async function write(tx: Tx, source: PosBirData, target: PosBirImportTarget, dryRun: boolean): Promise<PosBirImportReport> {
  const importedAt = new Date()
  const skipped: PosBirImportIssue[] = []
  const warnings: PosBirImportIssue[] = []
  const issue = (list: PosBirImportIssue[], kind: PosBirRowKind, id: string) => (reason: string) => list.push({ kind, id, reason })

  await checkTarget(tx, target)
  await refuseReimport(tx, source, target)

  // Rows without an id can't be imported (SQLite lets a TEXT PRIMARY KEY be NULL)
  const withIds = (kind: PosBirRowKind, rows: Row[]) =>
    rows.flatMap((row) => {
      const raw = text(row.id)
      if (!raw) {
        skipped.push({ kind, id: "", reason: `a ${kind} without an id (${text(row.name ?? row.full_name) ?? "no name"})` })
        return []
      }
      const id = serverId(kind, raw, target)
      // Reported only for rows that are imported
      const why = UUID_RE.test(raw) ? "POS-bir gives its built-in Administrator the same id on every install" : "its id is not a UUID"
      const renamed = id === raw.toLowerCase() ? null : `${why}; imported as ${id}`
      return [{ row, raw, id, renamed }]
    })

  // Categories: merged by name (case-insensitive) into the organization's existing ones
  const existingCategories = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.org_id, target.orgId), isNull(categories.deleted_at)))
  const categoryByName = new Map(existingCategories.map((c) => [c.name.trim().toLowerCase(), { id: c.id, name: c.name, existing: true }]))
  const categoryIds = new Map<string, string>() // POS-bir id -> server id
  const categoryRows: (typeof categories.$inferInsert)[] = []
  for (const { row, raw, id, renamed } of withIds("category", source.categories)) {
    const skip = issue(skipped, "category", raw)
    const name = text(row.name)
    if (!name) {
      skip("it has no name")
      continue
    }
    const same = categoryByName.get(name.toLowerCase())
    if (same) {
      categoryIds.set(raw, same.id)
      skip(
        same.existing
          ? `the organization already has a category "${same.name}": its products were put in that one`
          : `same name as POS-bir's category "${same.name}": its products were put in that one`
      )
      continue
    }
    if (renamed) warnings.push({ kind: "category", id: raw, reason: renamed })
    categoryRows.push({ id, org_id: target.orgId, name, created_at: timestamp(row.created_at) })
    categoryByName.set(name.toLowerCase(), { id, name, existing: false })
    categoryIds.set(raw, id)
  }

  // Products, and their current stock as one opening ADJUSTMENT for the target store
  const existingBarcodes = new Map(
    (
      await tx
        .select({ id: products.id, name: products.name, barcode: products.barcode })
        .from(products)
        .where(and(eq(products.org_id, target.orgId), isNull(products.deleted_at), isNotNull(products.barcode)))
    ).map((p) => [p.barcode as string, p])
  )
  const importedBarcodes = new Map<string, string>() // barcode -> POS-bir product name
  const productRows: (typeof products.$inferInsert)[] = []
  const movementRows: (typeof stockMovements.$inferInsert)[] = []
  for (const { row, raw, id, renamed } of withIds("product", source.products)) {
    const skip = issue(skipped, "product", raw)
    const warn = issue(warnings, "product", raw)
    const name = text(row.name)
    if (!name) {
      skip("it has no name")
      continue
    }
    const unitType = text(row.unit_type)
    if (unitType !== "QUANTITY" && unitType !== "WEIGHT") {
      skip(`"${name}" has an unknown unit type (${unitType})`)
      continue
    }
    const taxCategory = text(row.tax_category) ?? "VATABLE"
    if (!TAX_CATEGORIES.includes(taxCategory)) {
      skip(`"${name}" has an unknown tax category (${taxCategory})`)
      continue
    }
    const sellingPrice = money(num(row.selling_price))
    const costPrice = money(num(row.cost_price))
    if (!(sellingPrice >= 0 && costPrice >= 0)) {
      skip(`"${name}" has no valid selling or cost price (${String(row.selling_price)} / ${String(row.cost_price)})`)
      continue
    }
    const stock = row.stock_level === null || row.stock_level === undefined ? 0 : quantity(num(row.stock_level))
    const barcode = text(row.barcode)
    if (barcode) {
      const clash = existingBarcodes.get(barcode)
      if (clash) {
        skip(`"${name}": barcode ${barcode} is already used by "${clash.name}" (${clash.id}) in the organization; its stock (${stock}) was not imported either`)
        continue
      }
      const twin = importedBarcodes.get(barcode)
      if (twin) {
        skip(`"${name}": barcode ${barcode} is also on POS-bir's "${twin}", which was imported`)
        continue
      }
      importedBarcodes.set(barcode, name)
    }

    const rawCategory = text(row.category_id)
    const categoryId = rawCategory ? (categoryIds.get(rawCategory) ?? null) : null
    if (rawCategory && !categoryId) warn(`"${name}": its category (${rawCategory}) isn't in the import; imported without a category`)

    let supplierType = text(row.supplier_type) ?? "WHOLESALER"
    if (!SUPPLIER_TYPES.includes(supplierType)) {
      warn(`"${name}": unknown supplier type ${supplierType}, imported as WHOLESALER`)
      supplierType = "WHOLESALER"
    }

    // Wholesale price and threshold are set together or not at all; POS-bir only applied the
    // wholesale price when both were above zero (getActivePrice), so a half-set pair did nothing
    const wholesale = money(num(row.wholesale_price))
    const threshold = num(row.wholesale_threshold)
    let wholesalePrice: number | null = null
    let wholesaleThreshold = 0
    if (wholesale > 0 && threshold > 0) {
      wholesalePrice = wholesale
      wholesaleThreshold = Math.ceil(threshold)
      if (wholesaleThreshold !== threshold) warn(`"${name}": wholesale threshold ${threshold} rounded up to ${wholesaleThreshold}`)
    } else if (wholesale > 0 || threshold > 0) {
      warn(`"${name}": wholesale price ${String(row.wholesale_price)} with threshold ${String(row.wholesale_threshold)} never applied in POS-bir; dropped`)
    }

    let lowStockThreshold = num(row.low_stock_threshold)
    if (!(lowStockThreshold > 0)) lowStockThreshold = 0
    if (!Number.isInteger(lowStockThreshold)) {
      warn(`"${name}": low-stock threshold ${lowStockThreshold} rounded up to ${Math.ceil(lowStockThreshold)} (whole numbers only)`)
      lowStockThreshold = Math.ceil(lowStockThreshold)
    }

    let promoPrice: number | null = row.promo_price === null || row.promo_price === undefined ? null : money(num(row.promo_price))
    if (promoPrice !== null && !(promoPrice >= 0)) {
      warn(`"${name}": invalid promo price ${String(row.promo_price)} dropped`)
      promoPrice = null
    }

    if (renamed) warn(renamed)
    productRows.push({
      id,
      org_id: target.orgId,
      category_id: categoryId,
      name,
      barcode,
      selling_price: sellingPrice,
      cost_price: costPrice,
      unit_type: unitType,
      tax_category: taxCategory,
      supplier_type: supplierType,
      wholesale_price: wholesalePrice,
      wholesale_threshold: wholesaleThreshold,
      low_stock_threshold: lowStockThreshold,
      notify_low_stock: flag(row.notify_low_stock),
      is_promo: flag(row.is_promo),
      promo_price: promoPrice,
      created_at: timestamp(row.created_at),
    })

    if (!Number.isFinite(stock)) {
      warn(`"${name}": stock level ${String(row.stock_level)} is not a number; no opening stock imported`)
    } else if (stock !== 0) {
      if (stock < 0) warn(`"${name}": negative stock (${stock}) imported as is`)
      if (unitType === "QUANTITY" && !Number.isInteger(stock)) warn(`"${name}": fractional stock (${stock}) on a QUANTITY product`)
      movementRows.push({
        id: randomUUID(),
        store_id: target.storeId,
        terminal_id: null,
        device_seq: null,
        created_by: target.importedBy,
        created_at: importedAt,
        product_id: id,
        quantity_delta: stock,
        reason: "ADJUSTMENT",
        note: OPENING_STOCK_NOTE,
      })
    }
  }

  // Customers (store) and their balance as one opening ledger entry: a debt is a CHARGE, a credit in
  // the customer's favour an ADJUSTMENT of its absolute value (entries are never negative)
  const customerRows: (typeof customers.$inferInsert)[] = []
  const ledgerRows: (typeof creditLedger.$inferInsert)[] = []
  let openingBalanceTotal = 0
  for (const { row, raw, id, renamed } of withIds("customer", source.customers)) {
    const skip = issue(skipped, "customer", raw)
    const warn = issue(warnings, "customer", raw)
    const name = text(row.full_name)
    if (!name) {
      skip("it has no name")
      continue
    }
    const balance = row.current_debt_balance === null || row.current_debt_balance === undefined ? 0 : money(num(row.current_debt_balance))
    if (!Number.isFinite(balance)) {
      skip(`"${name}": balance ${String(row.current_debt_balance)} is not a number`)
      continue
    }
    let creditLimit = row.credit_limit === null || row.credit_limit === undefined ? 0 : money(num(row.credit_limit))
    if (!(creditLimit >= 0)) {
      warn(`"${name}": invalid credit limit ${String(row.credit_limit)}, imported as 0`)
      creditLimit = 0
    }
    let creditStatus = text(row.credit_status) ?? "ACTIVE"
    if (!CREDIT_STATUSES.includes(creditStatus)) {
      warn(`"${name}": unknown credit status ${creditStatus}, imported as ACTIVE`)
      creditStatus = "ACTIVE"
    }
    if (renamed) warn(renamed)
    customerRows.push({
      id,
      store_id: target.storeId,
      full_name: name,
      phone_number: text(row.phone_number),
      email: text(row.email),
      address: text(row.address),
      credit_limit: creditLimit,
      credit_status: creditStatus,
      created_at: timestamp(row.created_at),
    })
    if (balance !== 0) {
      ledgerRows.push({
        id: randomUUID(),
        store_id: target.storeId,
        terminal_id: null,
        device_seq: null,
        created_by: target.importedBy,
        created_at: importedAt,
        customer_id: id,
        entry_type: balance > 0 ? "CHARGE" : "ADJUSTMENT",
        amount: Math.abs(balance),
        running_balance: balance,
        notes: OPENING_BALANCE_NOTE,
      })
      openingBalanceTotal = money(openingBalanceTotal + balance)
    }
  }

  // Users (organization) with their bcrypt PIN hashes; no email or password yet
  const existingNames = new Set(
    (await tx.select({ name: users.full_name }).from(users).where(and(eq(users.org_id, target.orgId), isNull(users.deleted_at)))).map((u) =>
      u.name.trim().toLowerCase()
    )
  )
  const userRows: (typeof users.$inferInsert)[] = []
  const accessRows: (typeof userStores.$inferInsert)[] = []
  for (const { row, raw, id, renamed } of withIds("user", source.users)) {
    const skip = issue(skipped, "user", raw)
    const warn = issue(warnings, "user", raw)
    const name = text(row.full_name)
    const pinHash = text(row.pin_hash)
    if (pinHash === POS_BIR_DEFAULT_ADMIN_PIN_HASH) {
      skip(`POS-bir's default "${name ?? "Administrator"}" still has the seeded PIN (1234): create your own owner in the back office instead`)
      continue
    }
    if (!name) {
      skip("it has no name")
      continue
    }
    const role = text(row.role) as UserRole | null
    if (!role || !USER_ROLES.includes(role)) {
      skip(`"${name}" has an unknown role (${role})`)
      continue
    }
    const validHash = pinHash !== null && BCRYPT_RE.test(pinHash)
    if (!validHash) warn(`"${name}": the stored PIN is not a bcrypt hash; imported without a PIN (set one in the back office)`)
    if (existingNames.has(name.toLowerCase())) warn(`the organization already has a user named "${name}": check it isn't the same person`)
    if (renamed) warn(renamed)
    userRows.push({
      id,
      org_id: target.orgId,
      full_name: name,
      role,
      pin_hash: validHash ? pinHash : null,
      is_active: row.is_active === null || row.is_active === undefined ? true : flag(row.is_active),
      created_at: timestamp(row.created_at),
    })
    if (role !== "OWNER") accessRows.push({ user_id: id, store_id: target.storeId })
  }

  await insertAll(categoryRows, (chunk) => tx.insert(categories).values(chunk))
  await insertAll(productRows, (chunk) => tx.insert(products).values(chunk))
  await insertAll(movementRows, (chunk) => tx.insert(stockMovements).values(chunk))
  await insertAll(customerRows, (chunk) => tx.insert(customers).values(chunk))
  await insertAll(ledgerRows, (chunk) => tx.insert(creditLedger).values(chunk))
  await insertAll(userRows, (chunk) => tx.insert(users).values(chunk))
  await insertAll(accessRows, (chunk) => tx.insert(userStores).values(chunk))

  const history = source.history.filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`)
  const notes = [
    `Historical records were not imported${history.length > 0 ? ` (${history.join(", ")})` : ""}: the PC keeps them and syncs its own history once it is paired as a terminal.`,
    `Opening stock and balances are back-office entries dated ${importedAt.toISOString()}; they already include everything POS-bir recorded before, so history the PC syncs later must not change stock or balances again.`,
    "Imported users have no email or password: owners, admins and managers set those in the back office to sign in there. Their POS-bir PINs keep working on terminals.",
    "POS-bir's settings (business name, address and TIN, receipt options, invoice and Z counters) were not imported.",
  ]
  if (dryRun) notes.unshift("Dry run: everything was checked and rolled back; nothing was written.")

  return {
    dryRun,
    source: { businessName: source.businessName },
    categories: categoryRows.length,
    products: productRows.length,
    stockAdjustments: movementRows.length,
    customers: customerRows.length,
    openingBalances: ledgerRows.length,
    openingBalanceTotal,
    users: userRows.length,
    skipped,
    warnings,
    notes,
  }
}

async function insertAll<T>(rows: T[], insert: (chunk: T[]) => PromiseLike<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK))
}

async function checkTarget(tx: Tx, target: PosBirImportTarget) {
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, target.orgId), isNull(organizations.deleted_at)))
  if (!org) throw new PosBirImportError(`Organization ${target.orgId} not found`)
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, target.storeId), eq(stores.org_id, target.orgId), isNull(stores.deleted_at)))
  if (!store) throw new PosBirImportError(`Store ${target.storeId} not found in organization ${target.orgId}`)
  const [importer] = await tx
    .select({ role: users.role, is_active: users.is_active })
    .from(users)
    .where(and(eq(users.id, target.importedBy), eq(users.org_id, target.orgId), isNull(users.deleted_at)))
  if (!importer || !importer.is_active || (importer.role !== "OWNER" && importer.role !== "ADMIN")) {
    throw new PosBirImportError(`importedBy (${target.importedBy}) must be an active OWNER or ADMIN of organization ${target.orgId}`)
  }
}

/** Any POS-bir row already on the server (even soft-deleted) means this file was imported before */
async function refuseReimport(tx: Tx, source: PosBirData, target: PosBirImportTarget) {
  const idsOf = (kind: PosBirRowKind, rows: Row[]) =>
    rows.flatMap((row) => {
      const raw = text(row.id)
      return raw ? [serverId(kind, raw, target)] : []
    })
  const found: string[] = []
  const count = async (label: string, ids: string[], lookup: (chunk: string[]) => Promise<{ ours: boolean }[]>) => {
    let ours = 0
    let elsewhere = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      for (const row of await lookup(ids.slice(i, i + CHUNK))) {
        if (row.ours) ours++
        else elsewhere++
      }
    }
    if (ours > 0) found.push(`${ours} ${label} in this ${label === "customers" ? "store" : "organization"}`)
    if (elsewhere > 0) found.push(`${elsewhere} ${label} in another ${label === "customers" ? "store" : "organization"}`)
  }
  await count("products", idsOf("product", source.products), async (chunk) =>
    (await tx.select({ org: products.org_id }).from(products).where(inArray(products.id, chunk))).map((r) => ({ ours: r.org === target.orgId }))
  )
  await count("customers", idsOf("customer", source.customers), async (chunk) =>
    (await tx.select({ store: customers.store_id }).from(customers).where(inArray(customers.id, chunk))).map((r) => ({
      ours: r.store === target.storeId,
    }))
  )
  await count("categories", idsOf("category", source.categories), async (chunk) =>
    (await tx.select({ org: categories.org_id }).from(categories).where(inArray(categories.id, chunk))).map((r) => ({ ours: r.org === target.orgId }))
  )
  await count("users", idsOf("user", source.users), async (chunk) =>
    (await tx.select({ org: users.org_id }).from(users).where(inArray(users.id, chunk))).map((r) => ({ ours: r.org === target.orgId }))
  )
  if (found.length > 0) {
    throw new PosBirImportError(
      `This POS-bir database was already imported (${found.join(", ")} already exist). ` +
        "A re-import is a deliberate operation: import into a fresh organization and store."
    )
  }
}
