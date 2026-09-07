# Homely: one image serving both the built Vite frontend and the Express API.
# Why one container instead of nginx + node: for a single self-hosted server an
# Express `express.static()` serves the same bytes with one container, one
# process and no reverse-proxy config to maintain.

# ---- Stage 1: build the Vite frontend (homely/) ----
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json eslint.config.js ./
COPY assets ./assets
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# better-sqlite3 compiles from source (no prebuilt binary for this image), so
# both server stages need build tools. Only their non-dev deps run at runtime.
FROM node:20-slim AS server-builder
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Stage 3: slim runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=server-builder /app/server/package.json /app/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=server-builder /app/server/dist ./dist
COPY --from=frontend-builder /app/dist ./dist-static
EXPOSE 3000
CMD ["node", "dist/index.js"]
