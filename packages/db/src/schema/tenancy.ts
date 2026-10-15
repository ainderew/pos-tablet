// Organization -> stores -> terminals, and how a terminal proves who it is
import { sql } from "drizzle-orm"
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { money, timestamptz, versioned } from "./columns"

export const organizations = pgTable("organizations", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  ...versioned,
})

export const stores = pgTable(
  "stores",
  {
    id: uuid().primaryKey().defaultRandom(),
    org_id: uuid()
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    // Receipt header (ReceiptBusiness in @pos/core)
    business_name: text(),
    business_address: text(),
    business_tin: text(),
    receipt_header_lines: jsonb().$type<string[]>().notNull().default([]),
    receipt_footer_lines: jsonb().$type<string[]>().notNull().default([]),
    time_zone: text().notNull().default("Asia/Manila"),
    // Store policies the tablet applies offline (see docs/architecture.md, "Offline rules")
    stock_policy: text().notNull().default("enforce"),
    offline_credit_mode: text().notNull().default("A"),
    offline_credit_cap: money(),
    ...versioned,
  },
  (t) => [
    index("stores_org_idx").on(t.org_id),
    check("stores_stock_policy_check", sql`${t.stock_policy} in ('enforce', 'warn')`),
    check("stores_offline_credit_mode_check", sql`${t.offline_credit_mode} in ('A', 'B', 'C')`),
  ]
)

export const terminals = pgTable(
  "terminals",
  {
    id: uuid().primaryKey().defaultRandom(),
    store_id: uuid()
      .notNull()
      .references(() => stores.id),
    name: text().notNull(),
    kind: text().notNull().default("tablet"),
    // BIR registration (optional until the PTU question is settled)
    ptu_number: text(),
    serial_number: text(),
    min: text(),
    // Decommissioned: its devices can no longer sync (last-seen lives on device_tokens, which isn't
    // synced, so heartbeats don't bump the terminal's version)
    revoked_at: timestamptz(),
    ...versioned,
  },
  (t) => [index("terminals_store_idx").on(t.store_id), check("terminals_kind_check", sql`${t.kind} in ('tablet', 'desktop')`)]
)

/** A paired device's bearer token; only its SHA-256 is stored. Re-pairing a terminal issues a new one. */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    terminal_id: uuid()
      .notNull()
      .references(() => terminals.id),
    token_hash: text().notNull(),
    device_info: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    app_version: text(),
    created_at: timestamptz().notNull().defaultNow(),
    last_used_at: timestamptz(),
    revoked_at: timestamptz(),
  },
  (t) => [uniqueIndex("device_tokens_hash_idx").on(t.token_hash), index("device_tokens_terminal_idx").on(t.terminal_id)]
)

/** One-time code shown in the back office (as text and QR) to pair a device with a terminal */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    code_hash: text().primaryKey(),
    terminal_id: uuid()
      .notNull()
      .references(() => terminals.id),
    created_by: uuid().notNull(),
    created_at: timestamptz().notNull().defaultNow(),
    expires_at: timestamptz().notNull(),
    used_at: timestamptz(),
  },
  (t) => [index("pairing_codes_terminal_idx").on(t.terminal_id)]
)
