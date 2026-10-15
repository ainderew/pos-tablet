// Column helpers shared by every table
import { sql } from "drizzle-orm"
import { bigint, integer, numeric, pgSequence, timestamp, uuid } from "drizzle-orm/pg-core"

/** One global counter for every change to server-owned rows: tablets pull "everything after N" */
export const changeVersionSeq = pgSequence("change_version_seq")

export const money = () => numeric({ precision: 14, scale: 2, mode: "number" })
/** Stock quantities and weights, to the gram */
export const quantity = () => numeric({ precision: 14, scale: 3, mode: "number" })
export const timestamptz = () => timestamp({ withTimezone: true, mode: "date" })

/**
 * Server-owned rows (catalog, customers, users, settings): bumped to a new version on every insert
 * and update (trigger in the versioning migration) and soft-deleted, so deletes sync down too
 */
export const versioned = {
  version: bigint({ mode: "number" }).notNull().default(sql`nextval('change_version_seq')`),
  created_at: timestamptz().notNull().defaultNow(),
  updated_at: timestamptz().notNull().defaultNow(),
  deleted_at: timestamptz(),
}

/** Rows a terminal created and pushed (append-only): @pos/core's TerminalRecordSchema plus received_at */
export const terminalRecordColumns = () => ({
  id: uuid().primaryKey(),
  device_seq: integer().notNull(),
  created_at: timestamptz().notNull(), // device clock
  received_at: timestamptz().notNull().defaultNow(),
})
