# Architecture and build plan

Offline-first Android tablet POS that syncs to a server on the VPS. The PC app (POS-bir) keeps working
on its own and later becomes another terminal on the same server.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Terminals | 1 tablet per store today; the data model supports any number of stores and terminals per store |
| 2 | Store credit offline | **(A)**: allowed offline, up to the last-synced available credit (see [Store credit offline](#store-credit-offline)) |
| 3 | Printers | Bluetooth and USB; paper width unknown, so 58 mm and 80 mm are both supported |
| 4 | Tablet distribution | Manual APK install (sideload), with an in-app update check |
| 5 | Hosting | Existing VPS (`ssh_bb`). Production `pos.techpal.store`, staging `pos-staging.techpal.store` (DNS at HostGator) |
| 6 | PC app | Will sync to the same server as a `desktop` terminal |

## Overview

```
 Android tablet (per terminal)                       VPS (ssh_bb)
┌────────────────────────────────┐   HTTPS / sync   ┌───────────────────────────────┐
│ Capacitor app (React)          │ ───── push ────▶ │ nginx (TLS, certbot)          │
│  · POS UI                      │ ◀──── pull ───── │  └─ Next.js: back office, API │
│  · @pos/core (rules)           │                  │      /api/sync/v1/* (devices) │
│  · local SQLite (encrypted)    │                  │  └─ Postgres (container,      │
│  · outbox + sync worker        │                  │      not exposed publicly)    │
│  · BT/USB printer · scanner    │                  │  backups → off-site storage   │
└────────────────────────────────┘                  └───────────────────────────────┘
        PC app (Electron, POS-bir) ── same sync protocol, later ──▶
```

- **Every sale works offline.** Sales, voids, shifts, cash movements and Z-readings run on the
  device against its local database; the network is never on the critical path.
- **The server** is the sync hub, the backup, and the back office (catalog, users, customers,
  reports across stores and terminals).

## Scaling: organizations, stores, terminals

`organization → store → terminal`, where a terminal is a `tablet` or a `desktop` (the PC app).

- **Every row carries `store_id`**, and every record created on a terminal also carries
  `terminal_id` and `device_seq`. One tablet per store is simply the case N = 1.
- **Each terminal has its own counters**: SI and CN numbers, Z counter, grand total, and its own BIR
  PTU. Terminals never ask the server for a number, which is what makes offline and multi-terminal
  work together.
- **Stock is per store** and is the sum of stock movements, so several terminals in one store, plus
  restocks in the back office, merge without overwriting each other.
- **The catalog is per organization** (products, categories, prices), with room for per-store price
  overrides later. **Customers and their credit are per store.**
- **Server queries are always scoped** by organization and store; devices only ever receive data for
  their own store.

## What runs where

**On the terminal, working offline** (ported from POS-bir's API routes into local functions):
sale (`transactions`), `transactions/void`, transaction lookup and history, `shifts/current`,
`shifts/close`, `cash-movements`, `reports/z-reading` (+ local history), PIN login,
`auth/validate-manager`, `settings/verify-pin`, product search and barcode lookup, quick restock
(as a stock movement), customer search, `customers/payment` (as a ledger entry), statement printing,
and writing audit logs.

**On the server only** (back office, online): product create/edit/import/export, barcode generation,
categories, users, terminals and device pairing, settings, customer management and collection logs,
dashboards and reports (across terminals and stores), and viewing audit logs.

| Data | Source of truth | Sync |
|---|---|---|
| transactions, transaction_items, voids, shifts, cash_movements, daily_readings (Z), audit_logs, terminal-created credit_ledger entries, stock_movements | The terminal that created them | Up, append-only |
| products, categories, users (incl. PIN hashes), customers (profile, limit, status), settings, the terminal's own config | Server (back office) | Down |
| Stock level | Sum of stock movements | Server stock comes down; the terminal adds its own unsynced movements |
| Customer balance | Sum of ledger entries | Same as stock |
| collection_logs, devices/tokens, change log | Server | Not synced |

## Sync protocol (v1)

- **Records:** every record created on a terminal has a client-generated UUID, `store_id`,
  `terminal_id`, `device_seq` (a counter per device that only goes up), `created_at` (device clock)
  and `received_at` (set by the server).
- **Outbox:** each business write and its outbox entry are saved in the same local transaction.
- **Push:** `POST /api/sync/v1/push`, batches of about 100 records. The server inserts with
  `ON CONFLICT (id) DO NOTHING`, so a resend is harmless, and returns the highest `device_seq` it has
  stored. The terminal marks everything up to that number as synced.
- **Pull:** `GET /api/sync/v1/pull?cursor=N` returns changed catalog rows. Each server-owned table has
  a `version` column filled from one global sequence by a trigger; deletes are soft
  (`deleted_at`). The response also carries current stock levels and customer balances for the store.
- **Reconcile:** `GET /api/sync/v1/reconcile?date=` returns server totals per terminal and day (sales
  count, net, SI/CN range). The terminal compares them with its own records, re-pushes anything
  missing, and raises an alert on a mismatch.
- **Numbering check:** the server verifies each terminal's SI/CN numbers have no gaps or duplicates.
- **Photos:** audit photos go through a separate upload queue to object storage using pre-signed URLs
  (Wi-Fi-only option).
- **Versioning:** the API is under `/v1`, and the server supports the current and previous protocol
  versions, because manually installed tablets update at different times.

**Schedule**

| What | When |
|---|---|
| Push | After every write, then retries at 5 s, 30 s, 2 min, every 5 min; also on network-online and app resume |
| Pull | Every 3 min, on resume, and after each push |
| Forced sync | Before shift close and before the Z-reading (the Z still runs offline, with a warning) |
| Reconcile | Every 4 h and nightly |
| Heartbeat | Every 5 min (the back office shows "last seen") |
| Alerts | No sync for 24 h, or a sale unsynced for 12 h |

## Offline rules

- **Cash and e-wallet sales never block.** The terminal shows an unsynced banner, and a persistent
  warning after 72 h without a sync. The Z-reading always runs, because BIR requires it daily.
- **PIN login works offline** using the synced PIN hashes. A user created in the back office has to
  sync to a terminal before they can sign in on it.
- **The catalog is edited online only**, in the back office. Quick restock works offline.
- **A sale keeps the price actually charged** (`price_at_sale`), even if the price changed while
  offline.

### Store credit offline

Store credit ("utang") is a sale charged to a customer account with a credit limit. Offline, the
terminal only knows the customer's balance as of its last sync.

- **With one terminal per store this is safe.** Only that terminal adds charges, so its balance is
  never lower than the real one. A payment recorded in the back office while it was offline only
  makes it more cautious than necessary.
- **The risk appears with 2+ terminals in one store.** Two terminals that are both offline could each
  charge the same customer up to the limit. A customer blocked in the back office would also stay
  usable until the next sync.

Options:

- **(A) Allow offline, up to the last-synced available credit minus this terminal's own unsynced
  charges.** Chosen. Exact for one terminal per store; with more terminals, any over-limit
  balance is flagged in the back office after sync.
- **(B) Block store credit while offline.** Strict, but customers can't buy on credit during an outage.
- **(C) Allow at most ₱X of offline credit per customer.** A middle ground for stores with several
  terminals.

With (A), a block or limit change made in the back office during an outage also only reaches the
terminal at its next sync. This applies even with one terminal.

This is a per-store setting (`offline_credit_mode`, default `A`), so a store can switch to (B) or (C)
when it adds a second terminal.

## Hardware

- **Printing:** ESC/POS, rendered by `@pos/core` from the same receipt model as the HTML receipts.
  - Transports: Bluetooth Classic (SPP, which most thermal printers use), BLE, and USB OTG.
  - Paper width is a per-terminal setting: 58 mm (32 characters per line) or 80 mm (48).
  - Phase 1 spike: print on the real printer before committing to a Capacitor plugin. If no
    maintained plugin covers Bluetooth Classic and USB, write a small native plugin in Kotlin.
- **Scanner:** USB and Bluetooth scanners act as keyboards. Port `use-scan-detection`, including
  capturing scans that land in a focused field. Camera scanning (ML Kit) is optional later.
- **Camera:** the Capacitor camera, for audit photos.
- **Kiosk:** Android lock-task mode (screen pinning, or device-owner mode via a provisioning QR).

## Security

- **Back office:** session login (httpOnly cookie) with roles OWNER, MANAGER and ADMIN; every route
  is authenticated, with rate limiting.
- **Device pairing:**
  - The back office creates a terminal and shows a one-time code or QR that lasts 10 minutes.
  - The tablet trades it for a revocable device token, which it keeps in the Android Keystore.
  - The server stores only a hash of the token.
- **On the device:** the local database is encrypted (SQLCipher). PIN hashes are on the device for
  offline login, and 4–6 digit PINs can be brute-forced if the database is copied. Rely on encryption
  plus the Android screen lock, and consider longer manager PINs.
- **Philippine Data Privacy Act:** customer names and SC/PWD IDs are personal data. That means access
  controls, encrypted backups, and a privacy notice.

## Distribution (manual install)

- **Signing:** release APKs are signed with one release keystore, kept outside the repo with an
  off-site backup. **Losing it means installed tablets can't be updated.**
- **Hosting:** the server stores APKs (the repo is private, so GitHub downloads would need a login),
  behind device or back-office login.
- **In-app updates:** the app checks `GET /api/app/latest`, downloads the APK, and hands it to the
  Android installer. The tablet needs the "install unknown apps" permission.
- **Keystore in CI:** CI builds and signs the APK, with the keystore provided as an encrypted CI
  secret.

## Hosting on the VPS (`ssh_bb`)

- **Existing setup to fit into:** Ubuntu 24.04, 6 vCPU, 11 GB RAM, Docker and Compose. nginx and
  certbot on the host already serve other apps, each as a container bound to `127.0.0.1:<port>`.
- **Our deployment:**
  - A Compose project `pos` with the server bound to `127.0.0.1:3100`.
  - Its own Postgres container on an internal Docker network only.
  - Hostnames: `pos.techpal.store` (production, port 3101) and `pos-staging.techpal.store` (staging, port
    3100). Each has its own nginx site and certbot certificate (webroot challenge, the same as the
    existing sites) and its own Compose project and database.
  - Every tablet stores the production hostname when it's paired, so it must not change after rollout.
- **Backups:**
  - Continuous Postgres backups with point-in-time recovery (WAL-G or pgBackRest) to off-site
    S3-compatible storage.
  - Nightly `pg_dump`, kept for 30 days.
  - A restore drill every month.
- **Monitoring:** uptime checks on `/api/health`, Sentry for errors, and alerts from the sync monitor.

## PC app (POS-bir) path

1. Switch POS-bir to `@pos/core` (as a git dependency), so tax and pricing fixes land once.
2. Add a `desktop` terminal type: Electron runs the same sync worker against `better-sqlite3`.
3. Pair the PC as a terminal, upload its catalog and customers once, then sync like a tablet.
4. Its existing data model already has UUID keys, `pos_id` and `is_synced`, so the mapping is direct.

## Phases

| Phase | Scope | Exit criteria | Estimate |
|---|---|---|---|
| **0 – Groundwork** | Repo, CI, plan, staging on the VPS; BIR check; buy the tablet and printer | CI green; staging `/api/health` reachable over HTTPS | 2–3 days |
| **1 – Core** | Port pricing/tax (done), sale/void/shift-close/Z builders, receipt model + HTML/ESC-POS renderers, zod schemas; printer spike | Golden tests: identical totals and records to POS-bir for the same inputs | 4–5 days |
| **2 – Server + back office** | Postgres schema and migrations (Drizzle), org/store/terminal model, auth, device pairing, port back-office pages, import from a `pos.db` | Owner manages the catalog on staging; real data imported | 1.5–2 weeks |
| **3 – Sync engine** | push/pull/reconcile/heartbeat, versioning triggers, stock and ledger movements, `packages/sync` client, simulation harness | Server totals equal device totals after every failure scenario | ~1.5 weeks |
| **4 – Tablet app** | Capacitor Android, encrypted SQLite, all POS screens, scanner, BT/USB printing, camera, tablet layout | A full day offline on a real tablet reconciles correctly; receipts print | 2.5–3 weeks |
| **5 – Hardening + pilot** | Kiosk mode, in-app updates, production deploy, backups and restore drill, monitoring, security review, device-replacement procedure; 1–2 week pilot alongside the PC app | Pilot sign-off | 1.5–2 weeks |

Total: about 7–9 weeks for one developer.

### Status

- [x] Repo with pnpm workspaces and Turborepo, TypeScript strict, CI
- [x] `@pos/core`: PH tax, pricing and money rounding ported, with POS-bir's tests
- [x] `apps/server` (Next.js 16, `/api/health`) and `apps/tablet` (Vite + React 19 + Capacitor 8) scaffolds
- [x] Staging deploy on the VPS: https://pos-staging.techpal.store (HTTPS, private Postgres)
- [ ] BIR: PTU per tablet terminal, and the effect on software accreditation
- [ ] Choose the tablet and printer (Bluetooth/USB; paper width)
- [x] Store credit offline: (A)
- [x] Domain: `techpal.store` subdomains

## Risks

| Risk | Mitigation |
|---|---|
| Unsynced sales lost with a device | Push after every write, unsynced banner, encrypted local database |
| Duplicate invoice numbers after reinstalling or replacing a device | Counters restored from the server; a restore is blocked while the old outbox still has records; new PTU for replacement hardware |
| Wrong device clock | Record the server receive time and flag drift over 5 minutes |
| Several terminals overselling low stock | Live stock while online; stock may go negative locally, with an alert |
| Tablets running mixed app versions (manual install) | Versioned sync API; the server supports one version back |
| Printer plugin can't drive the chosen printer | Printer spike in Phase 1; fall back to a native plugin |
| BIR accreditation | Settle it in Phase 0, before Phase 4 |
