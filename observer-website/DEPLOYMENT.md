# Observer Website - Self-Hosted Deployment

This is a self-hosted Node.js application (not Cloudflare-dependent).

## Prerequisites

- Node.js 18+
- Company PostgreSQL database access
- `hermes_analytics` read-only role configured

## Installation

```bash
git clone <repo>
cd observer-website
npm install
npm run build
```

## Environment Setup

Create `.env` file:

```bash
DATABASE_URL=postgresql://hermes_analytics:password@db.example.com:5432/company_db
PORT=3000
LOG_LEVEL=info
```

## Running

```bash
npm run start
```

Server will listen on PORT (default 3000).

## Docker Deployment

Build:

```bash
docker build -t observer-website .
```

Run:

```bash
docker run \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  observer-website
```

## Database Connection

The app queries `observer.*` schema from Company PostgreSQL using the read-only `hermes_analytics` role.

Tables queried:
- `observer.decisions`
- `observer.experiments`  
- `observer.failures`

All queries are read-only. No mutations are possible.

## Monitoring

Check logs for any database connection errors:

```bash
tail -f /var/log/observer-website/app.log
```

## Immutability

All entries are append-only:
- `created_at` timestamp is permanent (creation only)
- No `updated_at` or edit functionality
- Deletion is impossible at the database level

This is documented in the UI: "Database entries are append-only."
