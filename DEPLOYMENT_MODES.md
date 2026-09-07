# Buildmyhouse Deployment Modes

## Overview

Buildmyhouse (the `buildmyhouse/` product + its server backend) supports two deployment modes:

1. **Local Development Mode**: SQLite database, optional telemetry (opt-in), runs entirely on a developer's machine or a single server
2. **Webserver Mode**: Neon PostgreSQL (managed Postgres), all telemetry enabled, designed for hosted deployments on Vercel/Cloudflare

The app detects which mode to use at startup based on environment variables and adapts:
- Database: SQLite (`buildmyhouse/server/data.db` or `:memory:`) in local mode, Neon PostgreSQL in webserver mode
- Telemetry: Completely optional (no-op by default) in local mode, always-on in webserver mode
- Signing/auth: Local mode uses unsigned tokens (dev-only), webserver mode uses real JWT signing

## Configuration

### Local Mode (Development)

**Trigger:** Any of the following:
- `DATABASE_URL` is unset or empty
- `NODE_ENV !== "production"`
- `TELEMETRY_OPT_IN` is explicitly unset or `false`

**Environment Variables:**
```bash
NODE_ENV=development
# DATABASE_URL unset or empty — triggers SQLite at ./data.db

# Telemetry (optional)
VITE_AXIOM_TOKEN=       # Leave empty to disable telemetry
VITE_AXIOM_DATASET=
VITE_AXIOM_ENDPOINT=

# Dev server runs on http://localhost:5173
PORT=5173
```

**Behavior:**
- Tauri app (`buildmyhouse/src-tauri/`) can run standalone with SQLite embedded
- Web app (`buildmyhouse/server/`) starts on localhost:5173 with in-memory or file-based SQLite
- Home projects saved to `data.db` locally (no cloud sync)
- Telemetry events silently dropped (or logged to console if enabled, but not sent)
- No authentication required

### Webserver Mode (Production/Hosting)

**Trigger:** Both of these:
- `DATABASE_URL` is set and points to a Neon PostgreSQL instance
- `NODE_ENV === "production"` (typical for Vercel/Cloudflare)

**Environment Variables:**
```bash
NODE_ENV=production
DATABASE_URL=postgresql://user:password@ep-*.neon.tech/dbname

# Telemetry (required in production)
VITE_AXIOM_TOKEN=<write-scoped token>
VITE_AXIOM_DATASET=buildmyhouse-telemetry
VITE_AXIOM_ENDPOINT=https://api.axiom.co

# Server runs on PORT (default 3000 or 8080 depending on platform)
PORT=3000
```

**Behavior:**
- Web app only (Tauri desktop app cannot use Neon; Tauri remains local)
- PostgreSQL stores all project data (multi-user capable, cloud sync ready)
- All telemetry events sent to Axiom (no opt-out in production mode)
- JWT signing required; secrets must be provisioned via Neon API or environment
- Suitable for Vercel, Cloudflare Workers, or any Node.js hosting

## Database Schema

### Local Mode (SQLite)

Database file: `buildmyhouse/server/data.db` (or `:memory:` in tests)

Tables:
- `home_projects` — home design files + metadata
- `user_sessions` — optional multi-user state (dev-only, not required)
- Migrations run automatically on app startup via `drizzle`

### Webserver Mode (Neon PostgreSQL)

Connection: `DATABASE_URL` (Neon connection string)

Same schema, but:
- Multi-user capable out of the box
- Supports concurrent reads/writes
- Cloud backups and point-in-time recovery (Neon feature)
- Telemetry correlation via `session_id` / `user_id` fields

## Telemetry Detail

### Local Mode

- **Default:** Telemetry completely disabled (no-op ingestion)
- **Opt-in:** Set `VITE_AXIOM_TOKEN` + `VITE_AXIOM_DATASET` to enable
- **Privacy:** User data never leaves the machine unless explicitly enabled

### Webserver Mode

- **Always on:** All telemetry events sent to Axiom
- **Scope:** Non-identifying telemetry only (feature usage, performance, errors)
- **What's included:** Button clicks, form submissions, API latencies, error messages (no passwords, home design content, PII)
- **Schema:** See `buildmyhouse/src/telemetry/events.ts` for the exact event types

## Migration Path

To move from Local → Webserver:

1. **Create a Neon account** and a new PostgreSQL database
2. **Export local data** from SQLite (if needed):
   ```bash
   sqlite3 data.db .dump > export.sql
   # Review/migrate the SQL to Neon schema as needed
   psql -h ep-*.neon.tech -U ... -d dbname < export.sql
   ```
3. **Set environment variables** for webserver mode
4. **Deploy** to Vercel/Cloudflare with the new `DATABASE_URL`
5. **Enable telemetry** (set Axiom credentials)

## Architecture Decisions

- **Why SQLite locally?** Fast iteration, no external dependencies, offline-capable
- **Why Neon in production?** Managed scaling, automatic backups, built-in monitoring, multi-user ready
- **Why optional telemetry in local mode?** Developers may not want to send usage data to third parties while developing; privacy-first by default
- **Why always-on in webserver mode?** Production deployments need observability; telemetry is scoped to non-identifying data only
