# pos-tablet

Offline-first Android tablet POS for a BIR-regulated Philippine general store, plus the VPS server
it syncs to. The PC app is the separate repo POS-bir (`/Users/drew/Desktop/projects/POS-bir`): the
reference behaviour for every business rule, and later another terminal syncing to this server.

**Read first:** `docs/architecture.md` (design, sync protocol, decisions, phases, status) and
`docs/api.md` (the server API contract; keep it in sync with the code).

## Layout
- `packages/core` — pure business rules shared by every terminal and the server: PH tax/rounding,
  `buildSale`/`buildVoid`/`buildCreditPayment`, shift open/close, cash movements, Z-readings,
  receipts (HTML + ESC/POS), record schemas (zod), sync protocol. Parity tests replay fixtures
  recorded from POS-bir (`test/fixtures/`; generators in `test/fixtures/generators/`).
- `packages/db` — Drizzle Postgres schema, migrations, PGlite test harness, POS-bir importer.
- `apps/server` — Next.js 16: back office (web), REST API, device pairing, sync push/pull.
- `apps/tablet` — Vite + React + Capacitor scaffold (Phase 4: the actual tablet app).
- `deploy/` — Docker/Compose, nginx template, `deploy.sh`, `setup-domain.sh`, `import-pos-bir.sh`.

## Commands
pnpm 9 via `npx -y pnpm@9.15.9` (pnpm isn't on PATH). The shell is zsh: never store a command in a
variable and run `$VAR args`; guard any `rm` of a variable path as `"${VAR:?}"`.
- `npx -y pnpm@9.15.9 check` — typecheck + tests + builds for everything (what CI runs).
- `npx -y pnpm@9.15.9 --filter @pos/server test` (or `@pos/core`, `@pos/db`).
- New migration: `cd packages/db && npx drizzle-kit generate --name <name>` (custom SQL: `--custom`).

## Conventions and pitfalls
- Records terminals create are **append-only** (DB triggers enforce it); a void is a new credit note.
  Every record has `device_seq` (creation order, never the clock). Server-owned rows are versioned
  (trigger + advisory lock so versions commit in order) and soft-deleted.
- Money is rounded to centavos (`roundMoney`/`toCents`); weights compared in thousandths.
- Back-office routes: `requireUser` + `storeForUser`/org checks; anything outside scope is 404.
  Device routes: `requireDevice`. Route files may only export HTTP handlers (Next rejects others).
- **Drizzle pitfall:** in a single-table select, columns render unqualified inside correlated
  subqueries (`"id"` binds to the inner table). Qualify the outer column by hand.
- Tests use PGlite (no Docker needed): `setupTestServer()` / `req()` in `apps/server/test/helpers.ts`.
- Server logs are prefixed `[v0]`. Don't edit copied shadcn files in `apps/server/components/ui`.
- After every push, watch CI (`gh run watch`); fix red builds before moving on.

## Deploy (VPS `ssh_bb`, shared with other apps — touch nothing else there)
- Staging: https://pos-staging.techpal.store (`/opt/pos-staging`, port 3100); production will be
  `pos.techpal.store` (port 3101), not set up yet. DNS is at HostGator (A records).
- `./deploy/deploy.sh staging` builds on the VPS and restarts; migrations run at server start.
  `./deploy/setup-domain.sh staging` (re)installs the nginx site + certificate safely (`nginx -t`).
- Secrets live only in `/opt/pos-<env>/.env` on the VPS (mode 600), never in the repo (it's public).

## Status (keep updated)
Phases 0–2 done; Phase 3 server side done (push/pull). Next: **Phase 4**, the tablet app: local
SQLite, outbox + sync worker (device side of the protocol), POS screens, scanner; browser and
Android emulator first (no hardware yet; printer spike deferred).

Open items:
- Owner creates their account on staging via `/setup`; afterwards remove `SETUP_TOKEN` from
  `/opt/pos-staging/.env` and restart.
- Optional: import the owner's real PC data (needs their POS-bir `pos.db`).
- Deferred by the owner: BIR PTU question; hardware (tablet, printer).
- Before production: separate DB roles (migration owner vs app), remove `SETUP_TOKEN`.
- Noted, not decided: serving other businesses (docs/architecture.md).
- Undecided: archive/delete the old private `ainderew/pos-cloud` repo; fix the four POS-bir bugs
  found during porting (seniors > pax, negative/unrounded payments, e-wallet debt payments at
  shift close, weight float stock).
