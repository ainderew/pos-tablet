// Users (back-office login and/or tablet PIN) and back-office sessions
import { sql } from "drizzle-orm"
import { boolean, check, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { timestamptz, versioned } from "./columns"
import { organizations, stores } from "./tenancy"

export const USER_ROLES = ["OWNER", "ADMIN", "MANAGER", "CASHIER"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    org_id: uuid()
      .notNull()
      .references(() => organizations.id),
    full_name: text().notNull(),
    role: text().$type<UserRole>().notNull(),
    // Back-office login (owners, admins, managers); cashiers usually have none
    email: text(),
    password_hash: text(),
    // Tablet login and manager approvals (bcrypt, synced down so it works offline)
    pin_hash: text(),
    is_active: boolean().notNull().default(true),
    ...versioned,
  },
  (t) => [
    index("users_org_idx").on(t.org_id),
    uniqueIndex("users_email_idx").on(sql`lower(${t.email})`).where(sql`${t.email} is not null and ${t.deleted_at} is null`),
    check("users_role_check", sql`${t.role} in ('OWNER', 'ADMIN', 'MANAGER', 'CASHIER')`),
  ]
)

/** Which stores a non-owner may work in (owners and admins see every store in the organization) */
export const userStores = pgTable(
  "user_stores",
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id),
    store_id: uuid()
      .notNull()
      .references(() => stores.id),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.store_id] })]
)

/** Back-office sessions; the cookie holds a random token and only its SHA-256 is stored */
export const sessions = pgTable(
  "sessions",
  {
    token_hash: text().primaryKey(),
    user_id: uuid()
      .notNull()
      .references(() => users.id),
    created_at: timestamptz().notNull().defaultNow(),
    expires_at: timestamptz().notNull(),
    last_used_at: timestamptz().notNull().defaultNow(),
    user_agent: text(),
    ip: text(),
  },
  (t) => [index("sessions_user_idx").on(t.user_id)]
)
