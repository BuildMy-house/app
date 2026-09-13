# Observer Website — Development

Self-hosted Node.js/Astro app (no Cloudflare). Read-only interface over the
Company PostgreSQL `observer.*` schema.

## Prerequisites

- Node.js 18+
- npm
- `make` (optional — you can use npm scripts directly)
- A Company PostgreSQL instance for live data (optional for static dev)

## Quick Start

```bash
cp .env.example .env      # set DATABASE_URL if you have Postgres
npm ci --force
npm run dev
```

Open http://localhost:3000.

## Verification

```bash
make check    # or: npx tsc --noEmit      — type check
make lint     # or: npx eslint src/       — lint
make build    # or: npx astro build       — production build
make preview  # or: npm run preview       — serve the production build
```

## Make Targets

| Target    | What it does                          |
|-----------|---------------------------------------|
| `install` | `npm ci --force`                      |
| `dev`     | Start the dev server on port 3000     |
| `build`   | Production build (SSR entry included) |
| `check`   | TypeScript type check (`tsc --noEmit`)|
| `lint`    | ESLint over the whole project         |
| `preview` | Serve the built app locally           |

## Environment Variables

| Variable       | Purpose                                          |
|----------------|--------------------------------------------------|
| `DATABASE_URL` | Read-only Postgres connection (`observer.*` schema) |
| `PORT`         | Server port (default 3000)                       |
| `LOG_LEVEL`    | `debug` / `info` / `warn` / `error`              |

## Project Layout

```
src/
  components/   Astro components (e.g. ObserverDataSample.astro)
  layouts/      Page layout (DataLayout.astro, shared chrome)
  pages/        Routes: index, decisions, experiments, failures
  pages/api/    JSON endpoints: /api/{decisions,experiments,failures}.json
  style/        Global stylesheet
astro.config.mjs  SSR output with @astrojs/node adapter
```

## Notes

- Data is append-only and read-only. The app never writes to the database.
- `npm ci --force` is used because a lockfile may not be committed yet; first
  run `npm install` to generate `package-lock.json` if it is absent.
