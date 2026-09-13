# Homely server

Backend for the Homely desktop app. An independent Node.js/TypeScript package —
this is **not** part of the Vite frontend in `../` (that app has its own
`package.json`, its own `src/`, and never imports from here).

Stack (decided by the architecture ticket, H1 — not up for debate here):

- **Express** for HTTP (well-documented; version 4 pinned for API stability)
- **better-sqlite3** for storage — a single-file embedded DB, no external service
- **bcrypt** for password hashing
- **jsonwebtoken** (JWT) for session tokens, sent as `Authorization: Bearer <token>`

## What it does today

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/register` | `{ email, password }` → creates a user, returns `{ token }` (201). `email` is normalized (trimmed, lowercased); passwords are hashed with bcrypt before storage. |
| `POST /api/auth/login` | `{ email, password }` → verifies credentials, returns `{ token }` (200). Failed attempts are counted in memory and the email is locked out (`429`) after 10 failures within a window. |
| (any route behind `requireAuth`) | Verifies the `Authorization: Bearer` JWT with `jwt.verify` and attaches the authenticated user id as `req.userId` — this id is the tenant identifier for every future multi-tenant endpoint. |

Other H-tickets (H2/H3) will mount their routes behind `requireAuth`; there are
no real protected endpoints yet, which is why the tests register a throwaway
`/api/protected` route to exercise the middleware.

### Auth middleware

```ts
import { requireAuth } from './src/auth.js';

app.get('/api/whatever', requireAuth, (req, res) => {
  // req.userId is the authenticated user's id (a UUID)
});
```

`registerHandler(db)` / `loginHandler(db)` / `requireAuth` are exported from
`src/auth.js` for H2+ to mount alongside the auth routes.

## Prerequisites

- Node.js **>= 20** (developed against Node 24)
- npm

## Setup

```bash
cd homely/server
npm install
```

## Required environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `JWT_SECRET` | **yes** | — | Signs JWTs. The server **refuses to start** (throws at boot) if this is unset — there is deliberately no hardcoded fallback. Generate one, e.g. `openssl rand -base64 48`. |

Optional:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `data/homely.db` (next to the package) | SQLite database file path |

## Running locally

```bash
cd homely/server

# Development (auto-reload):
JWT_SECRET="$(openssl rand -base64 48)" npm run dev

# Production-style: compile to dist/ then run it
JWT_SECRET=... npm run build
JWT_SECRET=... npm start
```

Quick smoke test (three separate shells or use the token from curl):

```bash
curl -s -X POST localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}'
# -> {"token":"eyJ..."}

curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}'
# -> {"token":"eyJ..."}
```

The SQLite database is created automatically on first boot
(`data/homely.db`; the `data/` directory is git-ignored). Schema: a single
`users` table (`id`, `email UNIQUE`, `password_hash`, `created_at`),
created idempotently at startup — no migration framework.

## Checks

```bash
npm run build      # tsc: src/ -> dist/
npm run typecheck  # tsc --noEmit over src/ + test/
npm test           # vitest + supertest (in-memory SQLite, no ports)
```

## Notes / known ceilings

- The failed-login lockout counter is **in-memory and per-process** — it resets
  when the server restarts and only counts against the configured `JWT_SECRET`
  instance. Fine for a single self-hosted server; move to a shared store when
  (if) multi-instance scaling is ever needed.
- SQLite is a single-file embedded DB. Swap to Postgres only if real
  multi-instance scaling is ever needed — not before.