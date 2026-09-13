# Website Development

Astro + Cloudflare adapter.

## Quick start

```bash
npm ci
npm run dev
```

Dev server runs at `localhost:4321`.

## Commands

```bash
make dev       # start dev server
make build     # production build
make check     # type-check (astro check + tsc)
make lint      # lint src/
make preview   # preview production build locally
```

## Stack

- Astro 7 (SSR via `output: 'server'`)
- `@astrojs/cloudflare` adapter
- TypeScript strict mode (ES2022)
- ESLint with `@astrojs/eslint-plugin`
