# pos-tablet

Offline-first tablet POS and the VPS server it syncs to, for General Store POS.
The existing Windows/macOS app lives in [POS-bir](https://github.com/ainderew/POS-bir); it stays
separate and will later sync to the same server as another terminal.

## Layout

| Path | What | Status |
|---|---|---|
| `packages/core` | Pure business rules shared by every app: PH tax, pricing, money rounding (sale/void/shift/Z builders and receipts next) | Phase 1, started |
| `apps/server` | Next.js back office + REST API + sync endpoints, on Postgres | Phase 0 scaffold (`/api/health`) |
| `apps/tablet` | Vite + React app packaged for Android with Capacitor; local SQLite, works offline | Phase 0 scaffold |
| `packages/sync`, `packages/db`, `packages/ui` | Sync protocol + device outbox, Drizzle schemas/migrations, shared UI | Added in Phases 2-4 |

The architecture, sync design and phased plan are in [docs/architecture.md](docs/architecture.md).

## Development

Requires Node 22+ and pnpm 9 (`corepack enable`, or `npx pnpm@9`).

```bash
pnpm install
pnpm check        # typecheck + tests + builds for every package (what CI runs)
pnpm --filter @pos/server dev   # http://localhost:3100
pnpm --filter @pos/tablet dev   # http://localhost:5173
```

Never commit the Android release keystore (`*.jks`, `*.keystore`): losing it means installed tablets can no longer be updated, so keep it (and its passwords) backed up outside the repo.
