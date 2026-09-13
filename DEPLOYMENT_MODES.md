# Buildmyhouse Deployment Modes

## Overview

Buildmyhouse (the `buildmyhouse/` product + its server backend) currently supports **one working deployment mode**:

1. **Local Development Mode** (SQLite, `better-sqlite3`): the only functional backend today

A second mode (Postgres) is sketched but **not implemented** — see [Postgres support](#postgres-support-not-yet-implemented) below.

For Docker-based self-hosting, see `buildmyhouse/docs/hosting.md` (the source of truth for deployment instructions).

## Local Development Mode (SQLite)

**Trigger:** `DATABASE_URL` is unset or empty (the default).

**Environment Variables:**
```bash
NODE_ENV=development
# DATABASE_URL unset — triggers SQLite at ./data.db

# Telemetry (optional, opt-in)
VITE_AXIOM_TOKEN=       # Leave empty to disable
VITE_AXIOM_DATASET=
VITE_AXIOM_ENDPOINT=

# Dev server runs on http://localhost:5173
PORT=5173
```

**Behavior:**
- Tauri app (`buildmyhouse/src-tauri/`) runs standalone with SQLite embedded
- Web app (`buildmyhouse/server/`) starts on localhost:5173 with file-based SQLite
- Home projects saved to `data.db` locally (no cloud sync)
- Auth uses unsigned tokens (dev-only)
- Telemetry events silently dropped unless opted in (see [Telemetry](#telemetry))

**Database file:** `buildmyhouse/server/data.db` (or `:memory:` in tests)

### Schema

Tables (defined in `buildmyhouse/server/src/db.ts`):

- **`users`** — `id TEXT PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL`
- **`assets`** — `id TEXT PK, user_id TEXT NOT NULL, catalog_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, width REAL NOT NULL, depth REAL NOT NULL, height REAL NOT NULL, color INTEGER, blob_key TEXT NOT NULL, glb_path TEXT NOT NULL, source_path TEXT, created_at INTEGER NOT NULL`
- **`homes`** — `id TEXT PK, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`

Once the H7 ticket (server-teams-multi-tenant) lands, the schema also includes `teams` and `team_members` tables, and `homes` gets a nullable `team_id` column.

Migrations are idempotent init-on-boot (`CREATE TABLE IF NOT EXISTS`) — no migration framework.

## Telemetry

Telemetry is **frontend-only** and **opt-in**. There is no server-side telemetry code.

- **Transport:** `buildmyhouse/src/telemetry/transport.ts` batches events and POSTs directly from the browser to Axiom's ingest endpoint via `fetch`
- **Gating:** disabled by default; enabled only when both `VITE_AXIOM_TOKEN` and `VITE_AXIOM_DATASET` are set (checked in `buildmyhouse/src/telemetry/config.ts`)
- **Privacy:** user data never leaves the machine unless the developer explicitly sets Axiom credentials
- **Scope:** non-identifying telemetry only (feature usage, performance, errors) — no passwords, home design content, or PII

There is no "always-on in production" behavior. Telemetry is entirely a development/observability opt-in.

## Postgres support (not yet implemented)

The codebase has a `DATABASE_URL` check in `buildmyhouse/server/src/db.ts` (`getDeploymentMode()`) and a stub `openPostgres()` function, but **Postgres mode does not work**. The stub returns an object exposing only `.exec()`, while every route handler calls the synchronous `better-sqlite3` API (`.prepare().get()`/`.run()`/`.all()`). Setting `DATABASE_URL` to a real Postgres connection string crashes on the first query.

**Do not set `DATABASE_URL` in production.** This will be implemented in ticket H8 (server-postgres-dual-mode-adapter).

For now, all deployments use SQLite. See `buildmyhouse/docs/hosting.md` for Docker-based self-hosting with SQLite.

## Why SQLite locally?

- Fast iteration, no external dependencies
- Offline-capable
- Single self-hosted instance (family, small team) — thousands of homes and hundreds of concurrent readers are comfortable
- Not built for concurrent writers across multiple replicas (do not run multiple app replicas against one SQLite file)

For horizontal scale-out, the model layer (`homes`, `users`, `assets` metadata) is small and well-bounded — the swap to Postgres will be a storage-engine change, not a schema redesign. When you hit the SQLite ceiling, see the "Postgres, later" section in `buildmyhouse/docs/hosting.md`.
