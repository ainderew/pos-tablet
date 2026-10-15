import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { categories, creditLedger, customers, organizations, products, stockMovements, stores, transactions, userStores, users } from "../src"
import type { Db } from "../src"
import {
  importPosBir,
  OPENING_BALANCE_NOTE,
  OPENING_STOCK_NOTE,
  POS_BIR_DEFAULT_ADMIN_ID,
  POS_BIR_DEFAULT_ADMIN_PIN_HASH,
  PosBirImportError,
} from "../src/import/pos-bir"
import type { PosBirImportReport } from "../src/import/pos-bir"
import { createTestDb } from "../src/testing"
import { buildPosBirDb, PIN_HASHES, POS_BIR_SCHEMA } from "./fixtures/pos-bir-db"

const TAKEN_BARCODE = "4800888141125" // an active back-office product already has it
const FREED_BARCODE = "4800888999999" // only a soft-deleted product had it

let t: Awaited<ReturnType<typeof createTestDb>>
let db: Db
let tmp: string

beforeAll(async () => {
  t = await createTestDb()
  db = t.db as unknown as Db
  tmp = mkdtempSync(path.join(tmpdir(), "pos-bir-import-test-"))
})
afterAll(async () => {
  await t.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A fresh organization (store, second store, owner, a "Snacks" category, two products) and an empty folder */
async function setupTarget() {
  const [org] = await db.insert(organizations).values({ name: "Sari-sari ni Maria" }).returning()
  const [store] = await db.insert(stores).values({ org_id: org.id, name: "Main" }).returning()
  const [branch] = await db.insert(stores).values({ org_id: org.id, name: "Branch" }).returning()
  const [owner] = await db.insert(users).values({ org_id: org.id, full_name: "Olivia Owner", role: "OWNER" }).returning()
  const [snacks] = await db.insert(categories).values({ org_id: org.id, name: "Snacks" }).returning()
  const base = { org_id: org.id, selling_price: 46, cost_price: 38, unit_type: "QUANTITY" }
  const [taken] = await db.insert(products).values({ ...base, name: "Safeguard (back office)", barcode: TAKEN_BARCODE }).returning()
  await db.insert(products).values({ ...base, name: "Old sachet", barcode: FREED_BARCODE, deleted_at: new Date() })
  return {
    org,
    store,
    branch,
    owner,
    snacks,
    taken,
    dir: mkdtempSync(path.join(tmp, "pc-")),
    target: { orgId: org.id, storeId: store.id, importedBy: owner.id },
  }
}
type Target = Awaited<ReturnType<typeof setupTarget>>

const buildPc = (s: Target) => buildPosBirDb(s.dir, { takenBarcode: TAKEN_BARCODE, freedBarcode: FREED_BARCODE })

/** Every row the import could write, for the target's organization and store */
async function snapshot(s: Target) {
  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id).sort()
  return {
    categories: ids(await db.select({ id: categories.id }).from(categories).where(eq(categories.org_id, s.org.id))),
    products: ids(await db.select({ id: products.id }).from(products).where(eq(products.org_id, s.org.id))),
    users: ids(await db.select({ id: users.id }).from(users).where(eq(users.org_id, s.org.id))),
    customers: ids(await db.select({ id: customers.id }).from(customers).where(eq(customers.store_id, s.store.id))),
    movements: ids(await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.store_id, s.store.id))),
    ledger: ids(await db.select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.store_id, s.store.id))),
    access: (await db.select({ id: userStores.user_id }).from(userStores).where(eq(userStores.store_id, s.store.id))).length,
  }
}

/** Stock per product in a store: the sum of its movements */
async function stockIn(storeId: string) {
  const rows = await db
    .select({ product: stockMovements.product_id, level: sql`sum(${stockMovements.quantity_delta})`.mapWith(Number) })
    .from(stockMovements)
    .where(eq(stockMovements.store_id, storeId))
    .groupBy(stockMovements.product_id)
  return Object.fromEntries(rows.map((r) => [r.product, r.level]))
}

/** Balance per customer in a store: CHARGE adds, PAYMENT and ADJUSTMENT deduct */
async function balancesIn(storeId: string) {
  const rows = await db
    .select({
      customer: creditLedger.customer_id,
      balance: sql`sum(case when ${creditLedger.entry_type} = 'CHARGE' then ${creditLedger.amount} else -${creditLedger.amount} end)`.mapWith(Number),
    })
    .from(creditLedger)
    .where(eq(creditLedger.store_id, storeId))
    .groupBy(creditLedger.customer_id)
  return Object.fromEntries(rows.map((r) => [r.customer, r.balance]))
}

/** The folder's files and their contents, to prove the import never touched them */
const filesIn = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => [f, createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")])

const counts = (r: PosBirImportReport) => {
  const { notes: _notes, dryRun: _dryRun, ...rest } = r
  return rest
}

describe("importPosBir", () => {
  it("uses POS-bir's real default Administrator seed", () => {
    expect(POS_BIR_SCHEMA).toContain(`VALUES ('${POS_BIR_DEFAULT_ADMIN_ID}', 'Administrator', '${POS_BIR_DEFAULT_ADMIN_PIN_HASH}', 'ADMIN')`)
  })

  it("imports the catalog, opening stock, customers with their balances, and users", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const before = filesIn(s.dir)
    const report = await importPosBir(db, pc.file, s.target)
    expect(filesIn(s.dir)).toEqual(before)

    expect(report).toMatchObject({
      dryRun: false,
      source: { businessName: "General Store POS" },
      categories: 3,
      products: 7,
      stockAdjustments: 6,
      customers: 4,
      openingBalances: 3,
      openingBalanceTotal: 4100.26,
      users: 4,
    })
    expect(report.skipped.map((x) => [x.kind, x.id])).toEqual([
      ["category", pc.ids.snacks],
      ["product", pc.ids.soap],
      ["user", POS_BIR_DEFAULT_ADMIN_ID],
    ])
    expect(report.skipped[0].reason).toMatch(/already has a category "Snacks"/)
    expect(report.skipped[1].reason).toMatch(new RegExp(`barcode ${TAKEN_BARCODE} is already used by "Safeguard \\(back office\\)" \\(${s.taken.id}\\).*stock \\(10\\)`))
    expect(report.skipped[2].reason).toMatch(/default "Administrator" still has the seeded PIN \(1234\): create your own owner/)
    expect(report.warnings.map((x) => [x.kind, x.id])).toEqual([
      ["product", pc.ids.rice], // low-stock threshold 5.5 -> 6
      ["product", pc.ids.bearBrand], // wholesale price without a threshold
      ["product", pc.ids.cigarettes], // negative stock
    ])
    expect(report.notes.join("\n")).toMatch(/not imported \(1 sales and credit notes, 1 shifts, 1 credit ledger entries\): the PC keeps them/)

    // Categories, merged by name into the existing "Snacks"
    const cats = await db.select().from(categories).where(eq(categories.org_id, s.org.id))
    expect(cats.map((c) => c.name).sort()).toEqual(["Beverages", "Frozen", "Rice & Grains", "Snacks"])
    expect(cats.find((c) => c.name === "Beverages")).toMatchObject({ id: pc.ids.beverages, created_at: new Date("2026-02-01T08:00:00Z") })

    // Products keep POS-bir's ids; prices to centavos
    const rows = await db.select().from(products).where(and(eq(products.org_id, s.org.id), isNull(products.deleted_at)))
    const byId = new Map(rows.map((p) => [p.id, p]))
    expect(rows).toHaveLength(1 + 7)
    expect(byId.has(pc.ids.soap)).toBe(false)
    expect(byId.get(pc.ids.coke)).toMatchObject({
      org_id: s.org.id,
      category_id: pc.ids.beverages,
      name: "Coca-Cola 1.5L",
      barcode: "4801981116072",
      selling_price: 75,
      cost_price: 62.5,
      unit_type: "QUANTITY",
      tax_category: "VATABLE",
      supplier_type: "WHOLESALER",
      wholesale_price: null,
      wholesale_threshold: 0,
      low_stock_threshold: 6,
      notify_low_stock: true,
      is_promo: false,
      promo_price: null,
      created_at: new Date("2026-02-01T08:05:00Z"),
    })
    expect(byId.get(pc.ids.rice)).toMatchObject({
      category_id: pc.ids.grains,
      barcode: null,
      unit_type: "WEIGHT",
      tax_category: "VAT_EXEMPT",
      supplier_type: "WET_MARKET",
      cost_price: 45.33,
      low_stock_threshold: 6,
    })
    expect(byId.get(pc.ids.canton)).toMatchObject({ category_id: s.snacks.id, wholesale_price: 16.5, wholesale_threshold: 12 })
    expect(byId.get(pc.ids.bearBrand)).toMatchObject({ wholesale_price: null, wholesale_threshold: 0, category_id: null })
    expect(byId.get(pc.ids.piattos)).toMatchObject({ is_promo: true, promo_price: 16 })
    expect(byId.get(pc.ids.shampoo)).toMatchObject({ barcode: FREED_BARCODE, tax_category: "ZERO_RATED" })

    // Stock: one opening ADJUSTMENT per product with stock, in the target store only
    expect(await stockIn(s.store.id)).toEqual({
      [pc.ids.coke]: 24,
      [pc.ids.rice]: 37.625,
      [pc.ids.canton]: 120,
      [pc.ids.piattos]: 30,
      [pc.ids.cigarettes]: -2,
      [pc.ids.shampoo]: 48,
    })
    expect(await stockIn(s.branch.id)).toEqual({})
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.store_id, s.store.id))
    for (const m of movements) {
      expect(m).toMatchObject({ reason: "ADJUSTMENT", note: OPENING_STOCK_NOTE, terminal_id: null, device_seq: null, created_by: s.owner.id, ref_id: null })
    }

    // Customers (store) and their balances, as the sum of the ledger
    const people = await db.select().from(customers).where(eq(customers.store_id, s.store.id))
    expect(people.map((c) => c.id).sort()).toEqual([pc.ids.nena, pc.ids.tonyo, pc.ids.ben, pc.ids.liza].sort())
    const customer = new Map(people.map((c) => [c.id, c]))
    expect(customer.get(pc.ids.nena)).toMatchObject({ full_name: "Aling Nena", phone_number: "09171234567", address: "Purok 3", email: null, credit_limit: 2000, credit_status: "ACTIVE" })
    expect(customer.get(pc.ids.tonyo)).toMatchObject({ email: "tonyo@example.com", credit_limit: 500 })
    expect(customer.get(pc.ids.ben)).toMatchObject({ email: null, address: null, credit_limit: 1000, credit_status: "BLOCKED" })
    expect(customer.get(pc.ids.liza)).toMatchObject({ credit_limit: 3000, credit_status: "OVERDUE" })
    expect(await balancesIn(s.store.id)).toEqual({ [pc.ids.nena]: 1250.76, [pc.ids.tonyo]: -150.5, [pc.ids.liza]: 3000 })
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.store_id, s.store.id))
    const entry = new Map(ledger.map((e) => [e.customer_id, e]))
    expect(entry.get(pc.ids.nena)).toMatchObject({ entry_type: "CHARGE", amount: 1250.76, running_balance: 1250.76 })
    expect(entry.get(pc.ids.tonyo)).toMatchObject({ entry_type: "ADJUSTMENT", amount: 150.5, running_balance: -150.5 })
    for (const e of ledger) {
      expect(e).toMatchObject({ notes: OPENING_BALANCE_NOTE, terminal_id: null, device_seq: null, created_by: s.owner.id, transaction_id: null, shift_id: null })
    }

    // Users keep their ids and bcrypt PIN hashes; no email or password; non-owners get the store
    const imported = await db
      .select()
      .from(users)
      .where(inArray(users.id, [pc.ids.owner, pc.ids.manager, pc.ids.cashier, pc.ids.former]))
    const user = new Map(imported.map((u) => [u.id, u]))
    expect(user.get(pc.ids.owner)).toMatchObject({ org_id: s.org.id, full_name: "Maria Santos", role: "OWNER", pin_hash: PIN_HASHES.owner, is_active: true })
    expect(user.get(pc.ids.manager)).toMatchObject({ role: "MANAGER", pin_hash: PIN_HASHES.manager })
    expect(user.get(pc.ids.cashier)).toMatchObject({ role: "CASHIER", pin_hash: PIN_HASHES.cashier, created_at: new Date("2026-03-15T01:30:00Z") })
    expect(user.get(pc.ids.former)).toMatchObject({ role: "CASHIER", pin_hash: PIN_HASHES.former, is_active: false })
    for (const u of imported) expect(u).toMatchObject({ email: null, password_hash: null })
    const access = await db.select().from(userStores).where(eq(userStores.store_id, s.store.id))
    expect(access.map((a) => a.user_id).sort()).toEqual([pc.ids.manager, pc.ids.cashier, pc.ids.former].sort())
    const admins = await db.select().from(users).where(and(eq(users.org_id, s.org.id), eq(users.full_name, "Administrator")))
    expect(admins).toHaveLength(0)

    // History stays on the PC
    expect(await db.select().from(transactions).where(eq(transactions.store_id, s.store.id))).toHaveLength(0)
  })

  it("does everything on a dry run but writes nothing", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const before = await snapshot(s)
    const dry = await importPosBir(db, pc.file, s.target, { dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, products: 7, stockAdjustments: 6, customers: 4, openingBalances: 3, users: 4 })
    expect(dry.notes[0]).toMatch(/^Dry run/)
    expect(await snapshot(s)).toEqual(before)

    // ...and leaves nothing behind that would get in the way of the real import, which matches it
    const real = await importPosBir(db, pc.file, s.target)
    expect(counts(real)).toEqual(counts(dry))
  })

  it("leaves nothing behind when a write fails mid-import", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const before = await snapshot(s)
    // Categories, products, stock and customers are written before the ledger fails
    await db.execute(sql.raw(`create function fail_ledger() returns trigger as $$ begin raise exception 'ledger is down'; end $$ language plpgsql`))
    await db.execute(sql.raw(`create trigger fail_ledger before insert on credit_ledger for each row execute function fail_ledger()`))
    try {
      const error = await importPosBir(db, pc.file, s.target).then(
        () => null,
        (e: Error & { cause?: Error }) => e
      )
      expect(error?.cause?.message ?? error?.message).toMatch(/ledger is down/)
    } finally {
      await db.execute(sql.raw(`drop trigger fail_ledger on credit_ledger`))
      await db.execute(sql.raw(`drop function fail_ledger()`))
    }
    expect(await snapshot(s)).toEqual(before)
    await expect(importPosBir(db, pc.file, s.target)).resolves.toMatchObject({ products: 7, openingBalances: 3 })
  })

  it("refuses a second import of the same pos.db", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    await importPosBir(db, pc.file, s.target)
    const before = await snapshot(s)
    const again = /already imported \(7 products in this organization, 4 customers in this store, 3 categories in this organization, 4 users in this organization already exist\)\. A re-import is a deliberate operation/
    await expect(importPosBir(db, pc.file, s.target)).rejects.toThrow(again)
    await expect(importPosBir(db, pc.file, s.target, { dryRun: true })).rejects.toThrow(again)
    // Into another organization too: its rows would share POS-bir's ids
    const other = await setupTarget()
    await expect(importPosBir(db, pc.file, other.target)).rejects.toThrow(/7 products in another organization, 4 customers in another store/)
    await expect(importPosBir(db, pc.file, other.target)).rejects.toBeInstanceOf(PosBirImportError)
    expect(await snapshot(s)).toEqual(before)
    expect((await snapshot(other)).products).toHaveLength(2)
  })

  it("imports a default Administrator whose PIN was changed, with an id per store (every install shares its id)", async () => {
    const changePin = (file: string) => {
      const sqlite = new DatabaseSync(file)
      sqlite.prepare("update users set pin_hash = ? where id = ?").run(PIN_HASHES.manager, POS_BIR_DEFAULT_ADMIN_ID)
      sqlite.close()
    }
    const a = await setupTarget()
    const b = await setupTarget()
    const pcA = buildPc(a)
    const pcB = buildPc(b)
    changePin(pcA.file)
    changePin(pcB.file)
    const reportA = await importPosBir(db, pcA.file, a.target)
    const reportB = await importPosBir(db, pcB.file, b.target)
    expect([reportA.users, reportB.users]).toEqual([5, 5])
    expect(reportA.warnings).toContainEqual({ kind: "user", id: POS_BIR_DEFAULT_ADMIN_ID, reason: expect.stringMatching(/same id on every install; imported as /) })
    const adminOf = async (s: Target) =>
      (await db.select().from(users).where(and(eq(users.org_id, s.org.id), eq(users.full_name, "Administrator"))))[0]
    const [adminA, adminB] = [await adminOf(a), await adminOf(b)]
    expect(adminA).toMatchObject({ role: "ADMIN", pin_hash: PIN_HASHES.manager })
    expect(adminB).toMatchObject({ role: "ADMIN", pin_hash: PIN_HASHES.manager })
    expect(adminA.id).not.toBe(adminB.id)
    expect(adminA.id).not.toBe(POS_BIR_DEFAULT_ADMIN_ID)
  })

  it("reads writes POS-bir hadn't checkpointed from pos.db-wal, without touching the files", async () => {
    const s = await setupTarget()
    const live = buildPosBirDb(s.dir, { takenBarcode: TAKEN_BARCODE, freedBarcode: FREED_BARCODE, keepOpen: true })
    // Copied while POS-bir was running (or after it crashed): the data is still in the -wal
    const copied = mkdtempSync(path.join(tmp, "copied-"))
    copyFileSync(live.file, path.join(copied, "pos.db"))
    copyFileSync(`${live.file}-wal`, path.join(copied, "pos.db-wal"))
    live.db?.close()
    const before = filesIn(copied)
    const report = await importPosBir(db, path.join(copied, "pos.db"), s.target)
    expect(report).toMatchObject({ categories: 3, products: 7, customers: 4, users: 4 })
    expect(filesIn(copied)).toEqual(before) // no -shm created, nothing checkpointed into pos.db
  })

  it("skips or adjusts rows it can't import as they are, and says why", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const sqlite = new DatabaseSync(pc.file)
    sqlite.exec("PRAGMA foreign_keys = OFF")
    const product = sqlite.prepare("insert into products (id, name, barcode, selling_price, cost_price, stock_level, unit_type, category_id, pos_id) values (?, ?, ?, ?, ?, ?, 'QUANTITY', ?, 'POS-01')")
    const orphan = randomUUID()
    const broken = randomUUID()
    const mystery = randomUUID()
    const twin = randomUUID()
    product.run("legacy-17", "Old stock item", null, 10, 8, 5, null)
    product.run(broken, "Broken price", null, "abc", 8, 1, null) // SQLite keeps text in a REAL column
    product.run(mystery, "Mystery stock", null, 5, 4, "n/a", null)
    product.run(twin, "Coke (typo)", " 4801981116072 ", 75, 62.5, 3, null) // Coca-Cola's barcode once trimmed
    product.run(orphan, "Orphan", null, 5, 4, 0, randomUUID())
    sqlite.prepare("update customers set current_debt_balance = 'x' where id = ?").run(pc.ids.ben)
    const legacyUser = randomUUID()
    sqlite.prepare("insert into users (id, full_name, pin_hash, role) values (?, 'Legacy PIN', '1234', 'CASHIER')").run(legacyUser)
    sqlite.close()

    const report = await importPosBir(db, pc.file, s.target)
    const reasons = (list: typeof report.skipped, id: string) => list.filter((x) => x.id === id).map((x) => x.reason)
    expect(reasons(report.skipped, broken)).toEqual([expect.stringMatching(/"Broken price" has no valid selling or cost price \(abc \/ 8\)/)])
    expect(reasons(report.skipped, twin)).toEqual([expect.stringMatching(/barcode 4801981116072 is also on POS-bir's "Coca-Cola 1.5L"/)])
    expect(reasons(report.skipped, pc.ids.ben)).toEqual([expect.stringMatching(/"Kuya Ben": balance x is not a number/)])
    expect(reasons(report.warnings, "legacy-17")).toEqual([expect.stringMatching(/its id is not a UUID; imported as [0-9a-f-]{36}/)])
    expect(reasons(report.warnings, mystery)).toEqual([expect.stringMatching(/stock level n\/a is not a number; no opening stock/)])
    expect(reasons(report.warnings, orphan)).toEqual([expect.stringMatching(/isn't in the import; imported without a category/)])
    expect(reasons(report.warnings, legacyUser)).toEqual([expect.stringMatching(/not a bcrypt hash; imported without a PIN/)])
    expect(report).toMatchObject({ products: 7 + 3, customers: 3, users: 5 })

    const legacyId = /imported as ([0-9a-f-]{36})/.exec(reasons(report.warnings, "legacy-17")[0])?.[1] as string
    const [legacy] = await db.select().from(products).where(eq(products.id, legacyId))
    expect(legacy).toMatchObject({ name: "Old stock item", selling_price: 10 })
    expect((await stockIn(s.store.id))[legacyId]).toBe(5)
    expect((await stockIn(s.store.id))[mystery]).toBeUndefined()
    const [legacyPin] = await db.select().from(users).where(eq(users.id, legacyUser))
    expect(legacyPin).toMatchObject({ role: "CASHIER", pin_hash: null })
  })

  it("checks the target", async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const other = await setupTarget()
    const [cashier] = await db.insert(users).values({ org_id: s.org.id, full_name: "Cara", role: "CASHIER" }).returning()
    const run = (target: Partial<typeof s.target>) => importPosBir(db, pc.file, { ...s.target, ...target })
    await expect(run({ orgId: randomUUID() })).rejects.toThrow(/^Organization .* not found$/)
    await expect(run({ storeId: other.store.id })).rejects.toThrow(/^Store .* not found in organization/)
    await expect(run({ importedBy: other.owner.id })).rejects.toThrow(/must be an active OWNER or ADMIN/)
    await expect(run({ importedBy: cashier.id })).rejects.toThrow(/must be an active OWNER or ADMIN/)
    await expect(run({ importedBy: "owner" })).rejects.toThrow("target.importedBy must be a UUID")
    expect((await snapshot(s)).products).toHaveLength(2)
  })

  it("rejects files that aren't a POS-bir database", async () => {
    const s = await setupTarget()
    const text = path.join(s.dir, "notes.txt")
    writeFileSync(text, "not a database at all, just some text that is long enough to have a header")
    const empty = path.join(s.dir, "empty.db")
    new DatabaseSync(empty).close()
    const other = path.join(s.dir, "other.db")
    const sqlite = new DatabaseSync(other)
    sqlite.exec("create table products (id text primary key); create table users (id text primary key)")
    sqlite.close()
    await expect(importPosBir(db, path.join(s.dir, "missing.db"), s.target)).rejects.toThrow(/^No such file/)
    await expect(importPosBir(db, text, s.target)).rejects.toThrow(/^Could not read .*notes\.txt: file is not a database/)
    await expect(importPosBir(db, empty, s.target)).rejects.toThrow(/is not a POS-bir database \(no categories, products, customers, users table\)/)
    await expect(importPosBir(db, other, s.target)).rejects.toThrow(/is not a POS-bir database \(no categories, customers table\)/)
  })
})

describe("CLI", () => {
  const cli = fileURLToPath(new URL("../src/import/cli.ts", import.meta.url))
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--experimental-strip-types", cli, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
      )
    })

  it("explains its arguments", { timeout: 30_000 }, async () => {
    const result = await run(["--sqlite", "pos.db"])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^usage: /)
  })

  // Plain Node, no bundler: proves the module graph (and node:sqlite) loads, up to connecting
  it("runs under Node's type stripping and never prints the database password", { timeout: 30_000 }, async () => {
    const s = await setupTarget()
    const pc = buildPc(s)
    const ids = ["--org-id", s.org.id, "--store-id", s.store.id, "--imported-by", s.owner.id]
    const result = await run(["--sqlite", pc.file, ...ids, "--dry-run"], { DATABASE_URL: "postgres://pos:hunter2-secret@127.0.0.1:1/pos" })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/\[import\] failed, nothing was written: connect ECONNREFUSED 127\.0\.0\.1:1/)
    expect(result.stderr).not.toContain("hunter2")
  })
})
