# Deployment to Cloudflare Workers

Same setup as the main website. See root CLOUDFLARE_SETUP.md for details.

## Key Points

- This site uses Astro SSR mode on Cloudflare Workers
- Optional: DATABASE_URL env var for querying Observer data (future feature)
- Deployed automatically via GitHub Actions on push
- Domain: hermees.domain.com
