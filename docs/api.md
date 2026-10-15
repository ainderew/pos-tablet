# Server API (back office and devices)

JSON over HTTPS. Field names are the database column names (snake_case); money is a number with 2
decimals, quantities a number with up to 3. Timestamps are ISO 8601 strings.

## Rules for every route

- **Back-office routes** authenticate with the `pos_session` cookie via `requireUser` (OWNER, ADMIN,
  MANAGER; cashiers never sign in to the back office). Every state-changing request must be
  same-origin (CSRF). **Device routes** use `Authorization: Bearer <device token>` via `requireDevice`.
- **Scope:** a user only sees their own organization. Owners and admins see every store in it;
  managers only the stores they're assigned to. Anything outside the caller's scope is **404**, not
  403, so ids can't be probed.
- **Errors:** `{ "error": { "code": "UPPER_SNAKE", "message": "Human text", "issues"?: [{ path, message }] } }`.
  400 `INVALID_INPUT` (zod issues), 401 `UNAUTHORIZED`, 403 `FORBIDDEN` (signed in but not allowed),
  404 `NOT_FOUND`, 409 conflicts with a specific code, 429 `TOO_MANY_ATTEMPTS`.
- **Deletes are soft** (`deleted_at`), so they sync down to tablets; lists leave deleted rows out
  unless `?include_deleted=1`. Every update bumps the row's `version` (database trigger).
- **Lists** are returned whole for now (a store has hundreds to a few thousand products); `?search=`
  matches case-insensitively on the listed fields.

## Auth and devices (built)

| Method | Path | Who | Body / result |
|---|---|---|---|
| POST | `/api/setup` | anyone with `SETUP_TOKEN`, only while no users exist | `{ setup_token, organization_name, store_name, owner_name, email, password (≥10), pin? }` → 201 `{ organization_id, store_id, owner_id }`; 409 `ALREADY_SET_UP` |
| POST | `/api/auth/login` | — | `{ email, password }` → `{ user }` + cookie; 401 `INVALID_CREDENTIALS`; 429 |
| POST | `/api/auth/logout` | signed in | → `{ ok: true }` |
| GET | `/api/auth/me` | signed in | → `{ user: { id, full_name, role, email, org_id, store_ids: "ALL" \| string[] } }` |
| GET | `/api/stores/:storeId/terminals` | managers | → `{ terminals: [ ...terminal, paired: boolean, last_seen_at ] }` |
| POST | `/api/stores/:storeId/terminals` | managers | `{ name, kind?: "tablet"\|"desktop", ptu_number?, serial_number?, min? }` → 201 `{ terminal }` |
| POST | `/api/terminals/:terminalId/pairing-code` | managers | → `{ code: "ABCD-EFGH", expires_at, qr_payload }` (10 minutes, newest code only) |
| POST | `/api/terminals/:terminalId/unpair` | managers | → `{ revoked: number }` |
| POST | `/api/devices/pair` | device (public, rate-limited) | `{ code, device_info? }` → 201 `{ token, terminal, store, resume, server_time }` |
| GET | `/api/devices/me` | device | → `{ terminal, store, server_time }` |

## Stores, catalog and stock (organization catalog, per-store stock)

| Method | Path | Who | Body / result |
|---|---|---|---|
| GET | `/api/stores` | signed in | → `{ stores: Store[] }` the caller may work in |
| POST | `/api/stores` | OWNER, ADMIN | `{ name, business_name?, business_address?, business_tin? }` → 201 `{ store }` |
| GET | `/api/stores/:storeId` | managers | → `{ store }` |
| PATCH | `/api/stores/:storeId` | OWNER, ADMIN | any of `name, business_name, business_address, business_tin, receipt_header_lines (string[]), receipt_footer_lines (string[]), time_zone (IANA), stock_policy ("enforce"\|"warn"), offline_credit_mode ("A"\|"B"\|"C"), offline_credit_cap (number\|null; required for "C")` → `{ store }` |
| GET | `/api/categories` | managers | → `{ categories: Category[] }` (with `product_count`) |
| POST | `/api/categories` | managers | `{ name }` → 201 `{ category }`; 409 `DUPLICATE_NAME` |
| PATCH | `/api/categories/:id` | managers | `{ name }` → `{ category }`; 409 `DUPLICATE_NAME` |
| DELETE | `/api/categories/:id` | managers | → `{ ok: true }`; 409 `CATEGORY_IN_USE` while active products use it |
| GET | `/api/products` | managers | `?search=&category_id=&store_id=&include_deleted=1` → `{ products: Product[] }`; with `store_id`, each product also has `stock_level` and `is_low_stock` for that store |
| POST | `/api/products` | managers | `{ name, barcode?, selling_price, cost_price, unit_type, tax_category?, supplier_type?, category_id?, wholesale_price?, wholesale_threshold?, low_stock_threshold?, notify_low_stock?, is_promo?, promo_price? }` → 201 `{ product }`; 409 `DUPLICATE_BARCODE` |
| GET | `/api/products/:id` | managers | → `{ product }` |
| PATCH | `/api/products/:id` | managers | any product field → `{ product }`; 409 `DUPLICATE_BARCODE` |
| DELETE | `/api/products/:id` | managers | → `{ ok: true }` (soft) |
| GET | `/api/products/export` | managers | → CSV of the catalog (same columns as the import) |
| POST | `/api/products/import` | managers | `multipart/form-data` with `file` (CSV) → `{ created, updated, skipped, errors: [{ row, message }] }`; matches by barcode, else by name; only columns present in the header are updated (POS-bir's CSV format) |
| GET | `/api/stores/:storeId/stock` | managers | `?product_id=` → `{ stock: [{ product_id, stock_level }] }` (sum of movements) |
| POST | `/api/stores/:storeId/stock-movements` | managers | `{ product_id, quantity_delta (≠0, ≤3 decimals; integer for QUANTITY products), reason: "RESTOCK"\|"ADJUSTMENT", note? }` → 201 `{ movement, stock_level }` |
| GET | `/api/stores/:storeId/stock-movements` | managers | `?product_id=&limit=` → `{ movements }` newest first |

Product validation: prices ≥ 0; `wholesale_price` and `wholesale_threshold` set together or not at
all; `unit_type` is `QUANTITY` or `WEIGHT`; barcodes unique among the organization's active products.

## Customers and store credit (per store)

| Method | Path | Who | Body / result |
|---|---|---|---|
| GET | `/api/stores/:storeId/customers` | managers | `?search=&status=` → `{ customers: [ ...customer, balance ] }` (balance = sum of ledger entries) |
| POST | `/api/stores/:storeId/customers` | managers | `{ full_name, phone_number?, email?, address?, credit_limit? (≥0) }` → 201 `{ customer }` |
| GET | `/api/customers/:id` | managers | → `{ customer: { ...customer, balance } }` |
| PATCH | `/api/customers/:id` | managers | any of `full_name, phone_number, email, address, credit_limit, credit_status ("ACTIVE"\|"BLOCKED"\|"OVERDUE")` → `{ customer }` |
| DELETE | `/api/customers/:id` | managers | → `{ ok: true }`; 409 `HAS_BALANCE` while the balance isn't 0 |
| GET | `/api/customers/:id/ledger` | managers | → `{ entries }` oldest first, each with the sale's `invoice_number` when it has one |
| POST | `/api/customers/:id/payments` | managers | `{ amount (>0), payment_method: "CASH"\|"GCASH"\|"MAYA"\|"CARD", reference_number?, notes? }` → 201 `{ entry, balance, customer }` (a back-office PAYMENT, no terminal); a BLOCKED customer whose balance falls back within the limit becomes ACTIVE (POS-bir's rule) |

## Users (organization)

| Method | Path | Who | Body / result |
|---|---|---|---|
| GET | `/api/users` | managers | → `{ users: [ ...user without hashes, has_password, has_pin, store_ids ] }`; managers see the users of their stores |
| POST | `/api/users` | managers | `{ full_name, role, email?, password?, pin?, store_ids? }` → 201 `{ user }`; 409 `DUPLICATE_EMAIL` |
| PATCH | `/api/users/:id` | managers | any of `full_name, role, email, password, pin, is_active, store_ids` → `{ user }` |
| DELETE | `/api/users/:id` | managers | → `{ ok: true }` (soft; signs them out) |

Who may manage whom:
- **OWNER:** anyone.
- **ADMIN:** anyone except owners. An admin can't create owners.
- **MANAGER:** only cashiers, only in the manager's own stores, and only with those stores.
- **Everyone:** can't change their own role or deactivate or delete themselves. The last active owner
  can't be removed or demoted.

Field rules:
- **Back-office sign-in:** OWNER, ADMIN and MANAGER can sign in with an email and a password of at
  least 10 characters. Cashiers have no password.
- **PINs:** 4–6 digits, used for the tablet and for manager approvals. A user who is deactivated,
  deleted or given a new password is signed out of the back office.
- **Hashes:** never returned.
