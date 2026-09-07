# Observer Website

Public read-only interface for Hermees's decision log, experiments, and failure recovery. This is a self-hosted Node.js application that queries Company PostgreSQL directly.

## Features

- **Decisions**: Complete log of recorded decisions
- **Experiments**: Hypothesis, results, and metrics
- **Failures**: Postmortems and recovery strategies
- **API**: JSON endpoints for programmatic access

## Running Locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Environment Variables

Create `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Set `DATABASE_URL` to your Company PostgreSQL connection string. The user should have read-only `hermes_analytics` role.

## Building

```bash
npm run build
```

## Production Deployment

See DEPLOYMENT.md for Docker and self-hosted Node.js setup.

## API

Raw JSON data endpoints:

- `GET /api/decisions.json`
- `GET /api/experiments.json`
- `GET /api/failures.json`

All entries are append-only with timestamps. No update or delete operations.
