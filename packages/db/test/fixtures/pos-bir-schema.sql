-- Copy of POS-bir scripts/sqlite_schema.sql (POS-bir git 24f0a32; the file last changed in 6382056),
-- unmodified below this header. The importer tests build a pos.db from it, since CI has no POS-bir checkout.
-- Refresh it when POS-bir changes its schema: the importer reads categories, products, customers, users
-- and settings, and counts the history tables.

-- =====================================================
-- General Store POS - SQLite Schema
-- Consolidated from PostgreSQL schemas 001-009
-- =====================================================

-- 1. Settings Table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
('accumulated_grand_total', '0.00'),
('next_invoice_number', '1'),
('next_credit_note_number', '1'),
('manager_pin', '1234'),
('business_name', 'General Store POS'),
('business_address', '123 Business St, City'),
('business_tin', '000-000-000-000'),
('vat_rate', '12'),
('auto_print', 'false');

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CASHIER', 'MANAGER', 'OWNER')),
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Seed Default Admin User
INSERT OR IGNORE INTO users (id, full_name, pin_hash, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'Administrator', '$2b$10$tKWHEh7nlNKJKoRFBr6BXewNWkuZrEiUaeWUqNZJTQ0HdMCrMdv3K', 'ADMIN');

-- Trigger for users updated_at
CREATE TRIGGER IF NOT EXISTS trigger_update_user_timestamp
  AFTER UPDATE ON users
  FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- 3. Terminals Table
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  pos_id TEXT NOT NULL,
  ptu_number TEXT NOT NULL UNIQUE,
  serial_number TEXT NOT NULL UNIQUE,
  current_state TEXT DEFAULT 'CLOSED' CHECK (current_state IN ('OPEN', 'CLOSED')),
  accumulated_grand_total REAL NOT NULL DEFAULT 0.00,
  last_z_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_terminals_pos_id ON terminals(pos_id);
CREATE INDEX IF NOT EXISTS idx_terminals_ptu ON terminals(ptu_number);

-- Trigger for terminals updated_at + is_synced reset
CREATE TRIGGER IF NOT EXISTS trigger_update_terminal_timestamp
  AFTER UPDATE ON terminals
  FOR EACH ROW
BEGIN
  UPDATE terminals SET updated_at = datetime('now'), is_synced = 0 WHERE id = NEW.id;
END;

-- 4. Categories Table
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pos_id TEXT NOT NULL,
  is_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Trigger for categories updated_at + is_synced reset
CREATE TRIGGER IF NOT EXISTS update_categories_updated_at
  AFTER UPDATE ON categories
  FOR EACH ROW
BEGIN
  UPDATE categories SET updated_at = datetime('now'), is_synced = 0 WHERE id = NEW.id;
END;

-- 5. Products Table
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  selling_price REAL NOT NULL,
  cost_price REAL NOT NULL,
  stock_level REAL NOT NULL DEFAULT 0,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('QUANTITY', 'WEIGHT')),
  low_stock_threshold REAL DEFAULT 0,
  notify_low_stock INTEGER DEFAULT 0,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  tax_category TEXT DEFAULT 'VATABLE' CHECK (tax_category IN ('VATABLE', 'VAT_EXEMPT', 'ZERO_RATED')),
  supplier_type TEXT DEFAULT 'WHOLESALER' CHECK (supplier_type IN ('WHOLESALER', 'WET_MARKET', 'DIRECT_DELIVERY')),
  is_promo INTEGER DEFAULT 0,
  promo_price REAL,
  wholesale_price REAL,
  wholesale_threshold INTEGER DEFAULT 0,
  pos_id TEXT NOT NULL,
  is_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

-- Trigger for products updated_at + is_synced reset
CREATE TRIGGER IF NOT EXISTS update_products_updated_at
  AFTER UPDATE ON products
  FOR EACH ROW
BEGIN
  UPDATE products SET updated_at = datetime('now'), is_synced = 0 WHERE id = NEW.id;
END;

-- 6. Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'PAID' CHECK (status IN ('PAID', 'VOIDED', 'REFUND')),
  void_reason TEXT,
  authorized_by TEXT,
  void_authorized_by TEXT REFERENCES users(id),
  voided_at TEXT,
  transaction_type TEXT DEFAULT 'SALE' CHECK (transaction_type IN ('SALE', 'VOID_REFUND')),
  pos_id TEXT NOT NULL,
  is_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),

  -- Financials
  gross_sales REAL NOT NULL,
  vatable_sales REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  vat_exempt_sales REAL DEFAULT 0,
  zero_rated_sales REAL DEFAULT 0,
  total_discount REAL DEFAULT 0,
  net_sales REAL NOT NULL,

  -- Metadata
  pax_count INTEGER DEFAULT 1,
  senior_count INTEGER DEFAULT 0,
  sc_pwd_id TEXT,
  sc_pwd_name TEXT,

  -- Payment Info
  payment_method TEXT NOT NULL DEFAULT 'CASH',
  amount_tendered REAL,
  change_amount REAL,
  reference_number TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions(invoice_number);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_status_created ON transactions(status, created_at);

-- 7. Transaction Items Table
CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_sold REAL NOT NULL,
  price_at_sale REAL NOT NULL,
  cost_at_sale REAL NOT NULL,
  profit REAL GENERATED ALWAYS AS ((price_at_sale - cost_at_sale) * quantity_sold) STORED,
  tax_category TEXT NOT NULL,
  pos_id TEXT NOT NULL,
  is_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 8. Daily Readings Table
CREATE TABLE IF NOT EXISTS daily_readings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('X', 'Z')),
  reading_date TEXT DEFAULT (datetime('now')),
  total_sales REAL NOT NULL,
  total_vat REAL NOT NULL,
  beginning_invoice TEXT,
  ending_invoice TEXT,
  accumulated_grand_total REAL NOT NULL,
  pos_id TEXT NOT NULL,
  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_daily_readings_date ON daily_readings(reading_date);

-- 9. Shifts Table
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  pos_id TEXT NOT NULL,
  status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  start_time TEXT DEFAULT (datetime('now')),
  end_time TEXT,

  -- Cash Management
  opening_fund REAL NOT NULL DEFAULT 0,
  theoretical_cash REAL DEFAULT 0,
  actual_cash REAL DEFAULT 0,
  variance REAL DEFAULT 0,

  -- Digital Payments
  theoretical_gcash REAL DEFAULT 0,
  actual_gcash REAL DEFAULT 0,
  theoretical_maya REAL DEFAULT 0,
  actual_maya REAL DEFAULT 0,
  theoretical_card REAL DEFAULT 0,
  actual_card REAL DEFAULT 0,

  -- References
  terminal_id TEXT REFERENCES terminals(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Snapshots
  snapshot_z_counter INTEGER,
  snapshot_accumulated_total REAL,

  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shifts_terminal ON shifts(terminal_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);

-- 10. Cash Movements Table
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('CASH_IN', 'CASH_OUT', 'SAFE_DROP')),
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  is_synced INTEGER DEFAULT 0
);

-- 11. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  shift_id TEXT REFERENCES shifts(id) ON DELETE CASCADE,
  terminal_id TEXT REFERENCES terminals(id) ON DELETE SET NULL,

  action_type TEXT NOT NULL CHECK (action_type IN (
    'SHIFT_OPEN', 'SHIFT_CLOSE', 'CASH_IN', 'CASH_OUT', 'SAFE_DROP',
    'Z_READING', 'MANUAL_AUDIT', 'USER_LOGIN',
    'TRANSACTION_VOID', 'LINE_VOID'
  )),

  audit_image BLOB,
  audit_metadata TEXT, -- JSON stored as text

  created_at TEXT DEFAULT (datetime('now')),
  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_shift ON audit_logs(shift_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_terminal ON audit_logs(terminal_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- 12. Voids Table (Line Voids/Corrections)
CREATE TABLE IF NOT EXISTS voids (
  id TEXT PRIMARY KEY,
  shift_id TEXT REFERENCES shifts(id),
  cashier_id TEXT REFERENCES users(id),
  manager_id TEXT REFERENCES users(id),

  item_details TEXT NOT NULL, -- JSON stored as text
  reason TEXT NOT NULL,

  audit_image BLOB,

  occurred_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voids_shift ON voids(shift_id);

-- 13. Customers Table
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone_number TEXT,
  email TEXT,
  address TEXT,

  credit_limit REAL DEFAULT 0.00,
  current_debt_balance REAL DEFAULT 0.00,
  credit_status TEXT DEFAULT 'ACTIVE' CHECK (credit_status IN ('ACTIVE', 'BLOCKED', 'OVERDUE')),
  last_payment_date TEXT,

  total_spend REAL DEFAULT 0,
  last_visit_at TEXT,

  pos_id TEXT,
  is_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_full_name ON customers(full_name);
CREATE INDEX IF NOT EXISTS idx_customers_credit_status ON customers(credit_status);

-- Trigger for customers updated_at + is_synced reset
CREATE TRIGGER IF NOT EXISTS update_customers_updated_at
  AFTER UPDATE ON customers
  FOR EACH ROW
BEGIN
  UPDATE customers SET updated_at = datetime('now'), is_synced = 0 WHERE id = NEW.id;
END;

-- 14. Credit Ledger
CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) NOT NULL,

  transaction_id TEXT REFERENCES transactions(id),
  shift_id TEXT REFERENCES shifts(id),

  entry_type TEXT NOT NULL CHECK (entry_type IN ('CHARGE', 'PAYMENT', 'ADJUSTMENT')),
  amount REAL NOT NULL,

  running_balance REAL NOT NULL,

  occurred_at TEXT DEFAULT (datetime('now')),
  notes TEXT,

  pos_id TEXT,
  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer ON credit_ledger(customer_id, occurred_at DESC);

-- 15. Collection Logs
CREATE TABLE IF NOT EXISTS collection_logs (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) NOT NULL,
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),

  pos_id TEXT,
  is_synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_collection_logs_customer ON collection_logs(customer_id, created_at DESC);
