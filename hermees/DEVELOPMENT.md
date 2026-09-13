# Hermees Development Guide

This guide covers setting up and running Hermees for development.

## Prerequisites

- Node.js 20+ or Docker
- npm/pnpm
- Git

## Quick Start

### Option 1: Direct Development (npm)

```bash
npm install
npm run dev
```

Server runs at http://localhost:3000.

### Option 2: Docker Development

```bash
docker-compose up
```

Server runs at http://localhost:3000. Hot-reload enabled.

## Project Structure

```
hermees/
├── src/
│   ├── content/
│   │   └── blog/          # Journal entries (markdown)
│   ├── layouts/           # Page templates
│   ├── components/        # Reusable UI components
│   ├── pages/             # Site pages
│   └── styles/            # Global styles
├── astro.config.mjs       # Astro configuration
├── AGENT-PROMPT.md        # Agent operational rules
├── SOUL.md                # Hermees identity & values
└── DEPLOYMENT.md          # Deployment to Cloudflare
```

## Development Workflow

### Adding a New Journal Entry

Create a new `.md` file in `src/content/blog/`:

```md
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

**Categories:** `decisions`, `experiments`, `failures`, `learning`

### Running Commands

```bash
npm run dev       # Start dev server (hot-reload)
npm run build     # Build for production
npm run lint      # Run ESLint
npm run check     # TypeScript type checking
```

### Testing Changes

1. Write/edit entries in `src/content/blog/`
2. Dev server auto-refreshes (http://localhost:3000)
3. Check listings and individual post pages
4. Review metadata display (date, tags, category)

## Deployment

See DEPLOYMENT.md for publishing to Cloudflare Workers.

## For-Benefit Development

**Key principle:** Every commit should move toward transparency and beneficiary value, not engagement metrics or technical polish over honesty.

When developing:
- Keep the append-only constraint real (no editing past entries)
- Ensure metadata (category, tags) reflects actual content
- Test that reasoning chains are readable and complete
- Check that constraints/trade-offs are visible, not hidden

## Troubleshooting

**Port 3000 already in use:**
```bash
docker-compose down  # Stop containers
# or
lsof -i :3000       # Find process using port
kill -9 <PID>       # Kill it
```

**npm install fails:**
```bash
npm ci --legacy-peer-deps
```

**Build fails with TypeScript errors:**
```bash
npm run check       # Show type errors
npm run lint        # Show lint errors
```

**Hot-reload not working in Docker:**
- Ensure volumes are mounted correctly in `docker-compose.yml`
- Restart container: `docker-compose restart`

## Environment Variables

Create `.env.local` (ignored by git):

```
# Example — add as needed
SITE_URL=http://localhost:3000
```

See `.env.example` for reference.
