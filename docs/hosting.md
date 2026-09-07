# Hosting Homely with Docker

Homely ships as a single container that serves **both** the built web app and
the API. One image, one process, one reverse-proxy-free deployment.

- **API**: Express (Node 20) — auth, homes, asset upload.
- **Frontend**: the production Vite build, served by Express from
  `dist-static/` with an SPA fallback to `index.html`.
- **Persistence**: a named volume keeps the SQLite database and uploaded
  assets across container restarts.

## Quick start

```bash
cd homely

# 1. Set the signing secret (REQUIRED — the image refuses to start without it)
echo 'JWT_SECRET=change-me-to-a-long-random-string' > .env

# 2. Build and start
docker compose up -d --build

# 3. Open the app
#    http://localhost:3000
```

That's it. Register a user in the UI, draw a home, and it persists across
`docker compose restart`.

## Environment variables

Set these in a `.env` file next to `docker-compose.yml` (or in your shell).

| Variable       | Default        | Notes                                                              |
|----------------|----------------|--------------------------------------------------------------------|
| `JWT_SECRET`   | *(none — required)* | Signs auth tokens. Generate with `openssl rand -hex 64`. No default is shipped, on purpose. |
| `HOMELY_PORT`  | `3000`         | Host port mapped to the container's `:3000`.                       |

The container-internal paths (`DB_PATH`, `ASSET_DIR`, `STATIC_DIR`, `PORT`,
`JWT_SECRET`) are wired in `docker-compose.yml`; you rarely need to touch them.
For non-Docker or custom setups the server also honors `DB_PATH`, `ASSET_DIR`,
`STATIC_DIR` and `PORT` directly.

## Updating

```bash
cd homely
docker compose up -d --build   # rebuilds with your latest code, keeps data
```

## Backing up

All persistent state lives in the `homely-data` volume (SQLite + assets):

```bash
# Locate it
docker volume inspect homely_homely-data

# Back up the whole volume (recommended — captures assets + DB together)
docker run --rm -v homely_homely-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/homely-backup-$(date +%F).tgz -C /data .

# Or, while the container is stopped, dump just the SQLite DB
docker compose stop
docker run --rm -v homely_homely-data:/data -v "$PWD":/backup \
  alpine sh -c "cd /data && tar czf /backup/homely-db.tgz homely.db"
docker compose start
```

Restore by extracting the tarball back into the volume before starting the
container.

## SQLite scaling ceiling

The default backend is a single-file SQLite database (`better-sqlite3`) shared
inside the `homely-data` volume. This is the right choice for:

- A single self-hosted instance (family, small team)
- One machine, no multi-replica writes

SQLite is not built for **concurrent writers across multiple replicas**, so do
not run multiple Homely app replicas against one SQLite file — you'll get
`SQLITE_BUSY` under load.

Rough ceiling (single node, healthy WAL): thousands of homes and hundreds of
concurrent readers are comfortable; sustained **multi-writer** load (many users
saving homes/LARGE GLB uploads at once) is where it starts to strain.

### Postgres, later

For horizontal scale-out the model layer (`homes`, `users`, `assets` metadata)
is small and well-bounded — the swap to Postgres is a storage-engine change,
not a schema redesign. It is *not* done yet: do not point deployment tooling at
a `DATABASE_URL`.

**Rule of thumb**: stay on SQLite until you actually hit the ceiling. When you
do, the work is:

1. Add a Postgres service to `docker-compose.yml`.
2. Replace `better-sqlite3` access with a Postgres client in
   `server/src/db.ts` / the routers.
3. Run the DB on its own named volume.

Uploaded asset **files** stay on the volume regardless — only the metadata
tables move to Postgres.

## Architecture note (why no nginx)

The frontend is just static files. Rather than standing up an nginx sidecar +
reverse proxy for one server, Express serves them directly and falls back to
`index.html` for client-side routes. Fewer moving parts for a self-hosted app;
add a reverse proxy (Caddy/Traefik/nginx) in front only if you need TLS or a
custom domain.
