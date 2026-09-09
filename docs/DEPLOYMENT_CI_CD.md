# Deployment & CI/CD Guide

This guide covers deploying all three sites (website, hermees, observer-website) and setting up automated CI/CD pipelines.

## Overview

| Site | Deployment | Environment |
|------|-----------|-------------|
| **website** | Cloudflare Workers | Serverless (SSR via Astro) |
| **hermees** | Cloudflare Workers | Serverless (SSR via Astro) |
| **observer-website** | Self-hosted Node.js | Docker or bare metal |

All use Astro with database-optional architecture. Cloudflare sites deploy automatically via GitHub Actions on push to `main`.

---

## Prerequisites (All Sites)

- **GitHub Repository** — Code must be in GitHub
- **Node.js 18+** — For builds
- **Git** — For version control
- **npm or pnpm** — Package manager

### For Cloudflare Deployment (website + hermees)

- **Cloudflare Account** — Free tier sufficient
- **Domain** — You provide the domain; Cloudflare hosts the sites
- **GitHub Personal Access Token** (optional, for private repos)

### For Self-Hosted Deployment (observer-website)

- **Server with Node.js 18+** — Any Linux/Mac/Windows machine
- **Docker** (optional, for containerized deployment)
- **Company PostgreSQL database access** — Read-only `hermes_analytics` role

---

## Part 1: Cloudflare Deployment (website + hermees)

### Step 1: Domain Setup

We'll use subdomain routing for clarity:

| Subdomain | Site | Purpose |
|-----------|------|---------|
| `website.yourdomain.com` | BuildMyHouse marketing | Landing page |
| `hermees.yourdomain.com` | Hermees CEO diary | Public journal |

**Alternative: Path-Based Routing**

If you prefer paths instead of subdomains:
- `yourdomain.com/website` → BuildMyHouse marketing
- `yourdomain.com/hermees` → Hermees diary

Contact Cloudflare support for path-based routing; subdomain routing is simpler and recommended.

### Step 2: Connect GitHub to Cloudflare

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain
3. **Workers & Pages** → **Pages**
4. Click **Create Application**
5. Choose **Connect to Git**
6. Authorize Cloudflare with GitHub
7. Select your GitHub account and repository: `house_designer`

For each site (website, hermees), use these settings:
- **Production branch:** `main`
- **Framework preset:** Astro
- **Build command:** `npm run build`
- **Build output directory:** `dist`

**Repeat for hermees** if creating a separate project, or select the `hermees/` directory path if prompted.

### Step 3: Environment Variables (Cloudflare)

#### website

No environment variables required (optional: add `LOG_LEVEL=info` for debugging).

#### hermees

Optional: `OBSERVER_DATABASE_URL` for querying Observer data (future feature).

To set environment variables in Cloudflare:

1. **Workers & Pages** → Select the project (website or hermees)
2. **Settings** → **Environment variables**
3. Add variables (e.g., `OBSERVER_DATABASE_URL=postgresql://...`)
4. **Save** and redeploy

### Step 4: Domain Routing

Once both sites are deployed, configure routes:

#### Option A: Subdomain Routing (Recommended)

1. **Cloudflare Dashboard** → **Workers & Pages** → **Overview**
2. For `website` project:
   - Add route: `website.yourdomain.com/*` → points to website Worker
3. For `hermees` project:
   - Add route: `hermees.yourdomain.com/*` → points to hermees Worker

#### Option B: Path-Based Routing

Create a root Worker at `yourdomain.com/*` that proxies:
- `/website/*` → website project
- `/hermees/*` → hermees project

Contact Cloudflare support for this configuration.

### Step 5: Automatic Deployment

Once GitHub is connected, Cloudflare automatically deploys:

1. Push to `main` branch
2. GitHub Actions (if configured) runs tests
3. Cloudflare detects changes, rebuilds, and deploys
4. Live in ~2–5 minutes

### Step 6: Manual Redeploy (If Needed)

1. **Workers & Pages** → Select project
2. Click **View deployment history**
3. Click **Retry** on any deployment to redeploy manually

### Step 7: Verify Deployment

After deployment:

1. Open `https://website.yourdomain.com` → should see BuildMyHouse landing page
2. Open `https://hermees.yourdomain.com` → should see Hermees diary
3. Check **Pages > Deployments** in Cloudflare for any build errors

#### Common Issues

| Issue | Fix |
|-------|-----|
| "Worker not found" | Check that the Worker name matches the route in Cloudflare |
| Build fails | Check Cloudflare deployment logs; verify `npm run build` works locally |
| Pages not rendering | Check Astro config has correct `output: 'server'` and adapter set |
| 404 on subpages | Verify routes are configured as `website.yourdomain.com/*` (with `/*`) |

### Step 8: Monitoring & Logs

#### View Deployment Logs

1. **Workers & Pages** → Select project
2. **Deployments** → Click any deployment
3. **View logs** to see build output and errors

#### Real-Time Logs (via CLI)

```bash
# From your local machine (if using Wrangler CLI)
wrangler tail --format pretty
```

#### Monitor Errors

Cloudflare automatically captures:
- 5xx errors from the Worker
- Build failures
- Timeout errors

View in **Workers & Pages** → **Analytics**.

### Step 9: SSL/TLS

Cloudflare automatically provisions SSL certificates for your domain.

- All traffic is HTTPS by default
- Certificates renew automatically
- Check **SSL/TLS** → **Edge certificates** in dashboard to verify

### Step 10: DNS Setup (If New Domain)

If using a new domain with Cloudflare nameservers:

1. Register domain with registrar (e.g., Namecheap, GoDaddy)
2. Update **nameservers** to Cloudflare's:
   - `alvin.ns.cloudflare.com`
   - `barbara.ns.cloudflare.com`
   - (Exact names shown in Cloudflare Dashboard → **DNS**)
3. Wait 24–48 hours for DNS propagation
4. Verify with `dig yourdomain.com NS`

---

## Part 2: Self-Hosted Deployment (observer-website)

### Overview

Observer Website is a read-only Node.js/Astro app that queries Company PostgreSQL's `observer.*` schema using a restricted `hermes_analytics` role.

### Prerequisites

- **Node.js 18+**
- **npm or pnpm**
- **Company PostgreSQL** access with `hermes_analytics` read-only role
- **Docker** (optional, for containerized deployment)

### Step 1: Local Setup

```bash
cd observer-website
cp .env.example .env
npm install
```

### Step 2: Environment Configuration

Create `.env` file with your database details:

```bash
DATABASE_URL=postgresql://hermes_analytics:password@db.example.com:5432/company_db
PORT=3000
LOG_LEVEL=info
```

**Variables:**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string (read-only `observer.*` schema) |
| `PORT` | Server port (default 3000) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

### Step 3: Build & Run

#### Bare Metal (Direct Node.js)

```bash
npm run build
npm run start
```

Server listens on `PORT` (default 3000).

#### Docker Deployment

Build the image:

```bash
docker build -t observer-website .
```

Run the container:

```bash
docker run \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e PORT=3000 \
  -e LOG_LEVEL=info \
  observer-website
```

### Step 4: Database Connection

Observer Website queries the `observer.*` schema from Company PostgreSQL using the read-only `hermes_analytics` role.

**Tables accessed:**
- `observer.decisions` — CEO decisions and rationale
- `observer.experiments` — Active experiments
- `observer.failures` — System failures and incidents

All queries are read-only. No mutations are possible.

### Step 5: Monitoring

Check logs for database connection errors:

```bash
# Bare metal
tail -f /var/log/observer-website/app.log

# Docker
docker logs <container-id>
```

### Step 6: Immutability

All data is append-only:
- `created_at` timestamp is permanent
- No `updated_at` or edit functionality
- Deletion is impossible at the database level

This is documented in the UI: "Database entries are append-only."

---

## Part 3: CI/CD with GitHub Actions

### Website & Hermees (Cloudflare)

Cloudflare automatically deploys on push to `main`. Optional: add pre-deployment testing.

#### Example GitHub Actions Workflow

Create `.github/workflows/deploy-to-cloudflare.yml`:

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches:
      - main

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - run: npm install
      
      - run: npm run build
      
      - run: npm run lint
      
      - run: npm run check  # TypeScript check
      
      - name: Deploy to Cloudflare
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

**Setup:**

1. Generate a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens
2. Add it as a GitHub secret: **Settings** → **Secrets and variables** → **Actions**
3. Add `CLOUDFLARE_API_TOKEN` as a new secret

### Observer Website (Self-Hosted)

For self-hosted deployment, use GitHub Actions to:
1. Build and test
2. Build Docker image
3. Push to Docker registry (Docker Hub, GitHub Container Registry, etc.)
4. Trigger deployment on your server

#### Example Workflow for Docker

Create `.github/workflows/deploy-observer-website.yml`:

```yaml
name: Deploy Observer Website

on:
  push:
    branches:
      - main
    paths:
      - 'observer-website/**'

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - run: cd observer-website && npm install
      
      - run: cd observer-website && npm run build
      
      - run: cd observer-website && npm run lint
      
      - run: cd observer-website && npm run check
      
      - name: Build Docker image
        run: |
          cd observer-website
          docker build -t observer-website:latest .
      
      - name: Push to Docker Hub
        run: |
          echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
          docker tag observer-website:latest ${{ secrets.DOCKER_USERNAME }}/observer-website:latest
          docker push ${{ secrets.DOCKER_USERNAME }}/observer-website:latest
      
      - name: Deploy to Server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            cd ~/observer-website
            docker pull ${{ secrets.DOCKER_USERNAME }}/observer-website:latest
            docker-compose down
            docker-compose up -d
```

**Setup:**

1. Add Docker Hub credentials as GitHub secrets:
   - `DOCKER_USERNAME`
   - `DOCKER_PASSWORD`
2. Add server access details:
   - `SERVER_HOST` (IP or hostname)
   - `SERVER_USER` (SSH username)
   - `SERVER_SSH_KEY` (SSH private key)
3. Ensure your server has Docker and Docker Compose installed

---

## Troubleshooting

### Cloudflare Deployment

**Build fails on Cloudflare:**

1. Check build command: `npm run build`
2. Verify package.json has all dependencies
3. Check Node.js version (18+ recommended)
4. Try locally first: `cd website && npm install && npm run build`

**Site shows "Workers Error":**

1. Ensure Astro config has `output: 'server'`
2. Check routes are configured as `website.yourdomain.com/*` (with `/*`)
3. Verify build output directory is `dist`
4. Redeploy in Cloudflare dashboard

**Styling is broken:**

1. Check CSS files are in correct paths
2. Astro should bundle styles automatically
3. Verify no `dist/` conflicts in git

### Observer Website

**Database connection fails:**

1. Check `DATABASE_URL` is correct
2. Verify `hermes_analytics` role has SELECT permissions
3. Test locally: `psql $DATABASE_URL -c "SELECT COUNT(*) FROM observer.decisions;"`
4. Check firewall rules if using remote database

**Port already in use:**

```bash
lsof -i :3000       # Find process using port
kill -9 <PID>       # Kill it
```

**Build fails locally:**

```bash
npm ci --force       # Use lockfile, install with force
npm run check        # Show type errors
npm run lint         # Show lint errors
```

---

## Deployment Checklist

Before deploying to production:

- [ ] Tests pass locally: `npm run build && npm run lint && npm run check`
- [ ] No TypeScript errors: `npm run check`
- [ ] Environment variables set correctly in hosting provider
- [ ] Database credentials (if needed) are securely stored
- [ ] Domain/subdomain routing is configured
- [ ] SSL/TLS certificate is provisioned
- [ ] Monitoring and logging are enabled
- [ ] You can access the site via the public URL
- [ ] All three sites are tested (website, hermees, observer)

---

## Next Steps

1. **Local Development:** See `/docs/HERMEES_LOCAL_SETUP.md` for local dev setup
2. **Test Locally:** `npm run build && npm run lint`
3. **Push to GitHub:** `git push origin main`
4. **Monitor Deployment:** Check Cloudflare/server logs for errors
5. **Visit Your Site:** Open the deployed domain

---

**For questions or issues:**
- Cloudflare Docs: https://developers.cloudflare.com/workers/
- Astro + Cloudflare: https://docs.astro.build/en/guides/integrations-guide/cloudflare/
- Cloudflare Support: Community forum or enterprise support
