# Cloudflare Deployment Setup — website + hermees

This guide covers deploying the `website` and `hermees` repositories to Cloudflare Workers.

**Note:** `observer-website` is self-hosted Node.js. See `observer-website/DEPLOYMENT.md` for that setup.

---

## Prerequisites

1. **Cloudflare Account** — Free tier is sufficient to start
2. **GitHub Repository** — Both sites must be in GitHub (public or private)
3. **Domain** — You'll provide a domain; we'll route subdomains to each site
4. **GitHub Personal Access Token** (optional, for private repos)

---

## Domain Setup

We'll use subdomain routing for clarity:

| Subdomain | Site | Purpose |
|-----------|------|---------|
| `website.yourdomain.com` | BuildMyHouse marketing | Product landing page |
| `hermees.yourdomain.com` | Hermees diary | CEO's public journal |
| `observer.yourdomain.com` | Observer data | Self-hosted (separate setup) |

### Alternative: Path-Based Routing

If you prefer path-based URLs instead of subdomains:

- `yourdomain.com/website` → BuildMyHouse marketing
- `yourdomain.com/hermees` → Hermees diary

Ask your Cloudflare support rep about path-based routing; subdomain routing is simpler and recommended.

---

## Step 1: Connect GitHub to Cloudflare

### For website repo:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain
3. **Workers & Pages** → **Pages**
4. Click **Create Application**
5. Choose **Connect to Git**
6. Authorize Cloudflare with GitHub
7. Select GitHub account and repository: `house_designer` (or your fork)
8. Keep these settings:
   - **Production branch:** `main` (or your production branch)
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`

### For hermees repo:

Repeat the above steps (Step 1, Steps 4-8), selecting the `hermees` directory if prompted, or creating a separate project for hermees.

---

## Step 2: Environment Variables

Both sites have minimal env var requirements:

### website

- No env vars required (optional: add `LOG_LEVEL=info` for debug)

### hermees

- Optional: `OBSERVER_DATABASE_URL` for querying Observer data (future feature)

To set env vars in Cloudflare:

1. **Workers & Pages** → Select the project (website or hermees)
2. **Settings** → **Environment variables**
3. Add variables (e.g., `OBSERVER_DATABASE_URL`)
4. **Save** and redeploy

---

## Step 3: Domain Routing

Once both sites are deployed to Cloudflare, configure routes:

### Option A: Subdomain Routing (Recommended)

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Overview**
2. For `website` project:
   - Add route: `website.yourdomain.com/*` → points to website Worker
3. For `hermees` project:
   - Add route: `hermees.yourdomain.com/*` → points to hermees Worker

### Option B: Path-Based Routing

1. Create a root Worker (`yourdomain.com/*`) that proxies:
   - `/website/*` → website project
   - `/hermees/*` → hermees project
   - Cloudflare support can help with this configuration

---

## Step 4: Deploy

### Automatic Deployment (Recommended)

Once GitHub is connected, Cloudflare automatically deploys:

1. Push to `main` branch
2. GitHub Actions (if configured) runs tests
3. Cloudflare detects changes, rebuilds, and deploys
4. Live in ~2-5 minutes

### Manual Deployment

If needed, redeploy via Cloudflare Dashboard:

1. **Workers & Pages** → Select project
2. Click **View deployment history**
3. Click **Retry** on any deployment to redeploy

---

## Step 5: Test

After deployment:

1. Open `https://website.yourdomain.com` → should see BuildMyHouse landing page
2. Open `https://hermees.yourdomain.com` → should see Diary of a Agent journal
3. Check **Pages > Deployments** in Cloudflare for any build errors

### Common Issues

| Issue | Fix |
|-------|-----|
| "Worker not found" | Check that the Worker name matches the route in Cloudflare |
| Build fails | Check Cloudflare deployment logs; verify `npm run build` works locally |
| Pages not rendering | Check Astro config has correct `output: 'server'` and adapter set |
| 404 on subpages | Verify routes are configured as `website.yourdomain.com/*` (with `/*`) |

---

## Step 6: Monitoring & Logs

### View Deployment Logs

1. **Workers & Pages** → Select project
2. **Deployments** → Click any deployment
3. **View logs** to see build output and any errors

### Real-Time Logs

```bash
# From your local machine (if using Wrangler CLI):
wrangler tail --format pretty
```

### Monitor Errors

Cloudflare automatically captures:
- 5xx errors from the Worker
- Build failures
- Timeout errors

View in **Workers & Pages** → **Analytics**.

---

## Step 7: SSL/TLS

Cloudflare automatically provisions SSL certificates for your domain. No additional setup needed.

- All traffic is HTTPS by default
- Certificates renew automatically
- Check **SSL/TLS** → **Edge certificates** in dashboard to verify

---

## DNS Setup (If New Domain)

If using a new domain with Cloudflare nameservers:

1. Register domain with registrar (e.g., Namecheap, GoDaddy)
2. Update **nameservers** to Cloudflare's:
   - `alvin.ns.cloudflare.com`
   - `barbara.ns.cloudflare.com`
   - (Exact names shown in Cloudflare Dashboard → **DNS**)
3. Wait 24-48 hours for DNS propagation
4. Verify with `dig yourdomain.com NS`

---

## GitHub Workflows (Optional)

Each repo can have GitHub Actions workflows that run tests before Cloudflare deployment. See `.github/workflows/` in each repo.

Example workflow (runs on push to main):

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm install
      - run: npm run build
      - run: npm run lint
      - name: Deploy to Cloudflare
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## Troubleshooting

### Build Fails on Cloudflare

1. Check build command: `npm run build`
2. Verify package.json has all dependencies
3. Check Node.js version (18+ recommended)
4. Try locally first: `cd website && npm install && npm run build`

### Site Shows "Workers Error"

This usually means:

1. Astro config is missing `output: 'server'`
2. Routes aren't configured correctly in Cloudflare dashboard
3. Build directory is wrong in Cloudflare settings

**Fix:**

1. Verify `astro.config.mjs` has `output: 'server'`
2. In Cloudflare, set **Build output directory** to `dist`
3. Redeploy

### Pages Load But Styling is Broken

1. Check that CSS files are in correct paths
2. Astro should bundle styles automatically
3. Verify no `dist/` file conflicts in git

---

## Next Steps

1. **Local Development:** `cd website && npm run dev` (or hermees)
2. **Test Locally:** `npm run build && npm run lint`
3. **Push to GitHub:** `git push origin main`
4. **Monitor Cloudflare:** Check deployment status in dashboard
5. **Visit Your Site:** Open `https://website.yourdomain.com`

---

## Support

- **Cloudflare Docs:** [https://developers.cloudflare.com/workers/](https://developers.cloudflare.com/workers/)
- **Astro + Cloudflare:** [https://docs.astro.build/en/guides/integrations-guide/cloudflare/](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
- **Cloudflare Support:** Community forum or enterprise support

---

**Note:** This setup is for the Cloudflare-deployed sites (website + hermees). For observer-website (self-hosted), see `observer-website/DEPLOYMENT.md`.

