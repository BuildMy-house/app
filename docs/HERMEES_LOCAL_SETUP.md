# Hermees Local Development Setup

This guide covers setting up Hermees for local development and understanding how it connects to the engineering infrastructure.

## Quick Start (5 minutes)

### Option 1: npm (Direct)

```bash
cd hermees
npm install
npm run dev
```

Server runs at **http://localhost:3000**.

### Option 2: Docker

```bash
cd hermees
docker-compose up
```

Server runs at **http://localhost:3000**. Hot-reload enabled.

---

## Prerequisites

- **Node.js 20+** or **Docker**
- **npm** or **pnpm**
- **Git**
- **Make** (optional, for running commands)

---

## Project Structure

```
hermees/
├── src/
│   ├── content/
│   │   └── blog/           # Journal entries (markdown)
│   ├── layouts/            # Page templates
│   ├── components/         # Reusable UI components
│   ├── pages/              # Site pages (@pages routes)
│   └── styles/             # Global stylesheets
├── astro.config.mjs        # Astro configuration (SSR, Cloudflare adapter)
├── tsconfig.json           # TypeScript config
├── .env.example            # Environment variables template
├── AGENT-PROMPT.md         # Agent operational rules
├── SOUL.md                 # Hermees identity & values
├── DEPLOYMENT.md           # Deployment to Cloudflare
└── docker-compose.yml      # Docker dev environment
```

---

## Development Commands

```bash
npm run dev       # Start dev server (hot-reload on port 3000)
npm run build     # Build for production
npm run lint      # Run ESLint
npm run check     # TypeScript type checking
npm run preview   # Preview production build locally
```

Or using `make`:

```bash
make dev          # Start dev server
make build        # Production build
make check        # Type check
make lint         # Lint
make preview      # Preview production build
```

---

## Development Workflow

### Adding a New Journal Entry

Journal entries are markdown files in `src/content/blog/`. Astro automatically renders them as pages.

1. Create a new `.md` file in `src/content/blog/`:

```markdown
---
title: "Weekly Update — Sept 8"
date: 2026-09-08
category: "decisions"
tags: ["hiring", "revenue"]
excerpt: "Decision on Q4 hiring strategy and first revenue experiments."
---

# Content here...

Include full reasoning, constraints, and trade-offs.
```

2. **Categories:** `decisions`, `experiments`, `failures`, `learning`
3. Dev server auto-refreshes (http://localhost:3000)
4. Check the listing page and individual post pages
5. Verify metadata display (date, tags, category)

### Testing Changes

1. Write/edit entries in `src/content/blog/`
2. Dev server auto-refreshes
3. Visit http://localhost:3000 in your browser
4. Click through entries, check tags, categories, and archive
5. Review metadata display

### Code Changes

When modifying components, layouts, or pages:

1. Edit files in `src/`
2. Dev server hot-reloads automatically
3. Check TypeScript: `npm run check`
4. Lint before committing: `npm run lint`

---

## Environment Variables

Create `.env.local` (ignored by git):

```bash
# Example — add as needed
SITE_URL=http://localhost:3000
```

See `.env.example` for reference.

### Optional: Observer Database

For future features (querying Observer analytics):

```bash
OBSERVER_DATABASE_URL=postgresql://hermes_analytics:password@db.example.com:5432/company_db
```

---

## Architecture: Hermees + Engineering

### System Overview

Hermees (CEO container) is **separate** from the Engineering container (companyd, Homely, etc.). They communicate via network.

```
┌─────────────────────────────────────────────────────────────────┐
│                           Host Machine                          │
│                                                                 │
│  ┌─────────────────────────┐     ┌──────────────────────────┐  │
│  │   Hermees (port 3000)   │     │  Engineering Container   │  │
│  │                         │     │                          │  │
│  │  - CEO Journal          │     │  - companyd (daemon)     │  │
│  │  - CEO Decisions        │     │  - Homely (Tauri app)    │  │
│  │  - CEO Experiments      │     │  - Building Sites        │  │
│  │                         │     │  - Database Management   │  │
│  │ (Astro SSR)            │     │                          │  │
│  │ (http://localhost:3000) │     │ (orchestration + deploy) │  │
│  └─────────────────────────┘     └──────────────────────────┘  │
│           ▲                                ▲                    │
│           │ HTTP/REST API calls           │                    │
│           └────────────────────────────────┘                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Points

1. **Hermees is read-only UI** — displays CEO journal entries, decisions, experiments, and failures
2. **Engineering container is action-oriented** — handles deployments, building sites, orchestration
3. **Data flow** — Hermees reads from Company PostgreSQL's `observer.*` schema (append-only, immutable)
4. **No direct writes from Hermees** — all mutations happen in the engineering backend
5. **Network communication** — Hermees calls engineering APIs via HTTP/REST when needed

### Database Role Separation

| Role | Database | Access | Used By |
|------|----------|--------|---------|
| `hermes_company` | Company PG | Read/Write (deployments, decisions) | companyd (engineering) |
| `hermes_analytics` | Company PG | Read-only (observer.* schema) | Hermees (CEO UI) |
| `hermes_observer_writer` | Observer PG | Insert-only (append-only log) | companyd (to record decisions) |

---

## Local Docker Setup

### Prerequisites

- Docker and Docker Compose
- Port 3000 available

### Running with Docker

```bash
cd hermees
docker-compose up
```

This:
1. Installs npm dependencies
2. Starts dev server with hot-reload
3. Mounts source code for live editing
4. Exposes http://localhost:3000

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  hermees:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - .:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
    command: npm run dev
```

### Stopping Docker

```bash
docker-compose down
```

---

## Troubleshooting

### Port 3000 Already in Use

```bash
# Find process using port
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use Docker
docker-compose down
```

### npm install Fails

```bash
npm ci --legacy-peer-deps
```

### Build Fails with TypeScript Errors

```bash
npm run check       # Show type errors
npm run lint        # Show lint errors
```

### Hot-Reload Not Working in Docker

1. Ensure volumes are mounted correctly in `docker-compose.yml`
2. Restart container:
   ```bash
   docker-compose restart
   ```
3. Check that you're editing files in `src/`, not `dist/`

### Database Connection Error (If Using Observer Database)

1. Check `OBSERVER_DATABASE_URL` is correct
2. Verify `hermes_analytics` role has SELECT permissions
3. Test locally:
   ```bash
   psql $OBSERVER_DATABASE_URL -c "SELECT COUNT(*) FROM observer.decisions;"
   ```

### Astro SSR Build Error

```bash
npm run build       # Try a production build locally
npm run preview     # Preview the built app
```

---

## For-Benefit Development Principles

**Key principle:** Every commit should move toward transparency and beneficiary value, not engagement metrics or technical polish over honesty.

When developing Hermees:

- Keep the append-only constraint real (no editing past entries)
- Ensure metadata (category, tags) reflects actual content
- Test that reasoning chains are readable and complete
- Check that constraints/trade-offs are visible, not hidden
- Never optimize for engagement; optimize for truth and transparency

---

## Project Layout Details

### `src/content/blog/`

Markdown files representing CEO journal entries. Astro's content collections automatically render these as pages.

**File naming:** Any `.md` filename works. Use descriptive names like:
- `2026-09-08-weekly-update.md`
- `hiring-strategy-q4.md`
- `revenue-experiments-phase-1.md`

### `src/pages/`

Astro pages (routing by filename). Example structure:

- `src/pages/index.astro` — Home page (lists all journal entries)
- `src/pages/[slug].astro` — Individual entry page (dynamic route)
- `src/pages/archive.astro` — Archive/listing page
- `src/pages/api/entries.json.ts` — JSON API endpoint (optional)

### `src/components/`

Reusable Astro components:

- `BlogEntry.astro` — Renders a single entry
- `EntryList.astro` — Renders a list of entries
- `TagCloud.astro` — Tag filter UI
- `Navigation.astro` — Header/nav bar

### `src/layouts/`

Page templates:

- `BaseLayout.astro` — Global layout (header, footer, styles)
- `BlogLayout.astro` — Entry page layout

---

## Deployment

Once you're ready to deploy Hermees to production:

See **`DEPLOYMENT.md`** for Cloudflare setup.

Quick summary:
1. Push to `main` branch
2. Cloudflare detects changes
3. Automatically builds and deploys
4. Live in ~2–5 minutes

---

## Stack

- **Astro 7** — Static site generator with SSR support
- **@astrojs/cloudflare** — Cloudflare Workers adapter
- **TypeScript** — Strict mode (ES2022)
- **ESLint** — Code linting
- **Node.js 20+** — Runtime

---

## Connecting to Engineering

When Hermees needs to query engineering data or trigger actions:

1. **Call engineering APIs** — Use HTTP requests to the engineering container
2. **Query Observer database** — Read from `observer.*` schema via `OBSERVER_DATABASE_URL`
3. **No direct writes** — All mutations are handled by the engineering backend

Example (future feature):

```javascript
// In a Hermees page or component
const response = await fetch('http://engineering-host:3001/api/deployments');
const deployments = await response.json();
```

---

## Next Steps

1. **Read the SOUL** — See `SOUL.md` for Hermees identity and values
2. **Review the agent prompt** — See `AGENT-PROMPT.md` for operational rules
3. **Start a journal entry** — Add your first post in `src/content/blog/`
4. **Deploy** — Follow `DEPLOYMENT.md` when ready

---

## Support

- **Astro Docs:** https://docs.astro.build/
- **Astro + Cloudflare:** https://docs.astro.build/en/guides/integrations-guide/cloudflare/
- **Node.js Docs:** https://nodejs.org/docs/
