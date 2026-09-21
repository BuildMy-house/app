# Homely: one image serving both the built Vite frontend and the Express API.
# Why one container instead of nginx + node: for a single self-hosted server an
# Express `express.static()` serves the same bytes with one container, one
# process and no reverse-proxy config to maintain.

# ---- Stage 1: build the Vite frontend (homely/) ----
FROM node:22-slim AS frontend-builder
WORKDIR /app
# prebuild regenerates textures via assets/textures/generate.py (Pillow).
# make/g++/python-is-python3/pkg-config+libx11-dev+libxi-dev+libxext-dev+
# libgl1-mesa-dev: the `gl` devDependency (headless WebGL for
# scripts/thumbnail-generator.ts) has no prebuilt binary and compiles its
# ANGLE backend from source via node-gyp -- needs a C++ toolchain, the
# `python` binary name specifically (Debian's python3 package alone doesn't
# symlink it), and the X11/GL dev headers ANGLE links against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python-is-python3 make g++ pkg-config \
      libx11-dev libxi-dev libxext-dev libgl1-mesa-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
# prebuild's thumbnails step renders with headless Chromium (Playwright).
RUN npx playwright install --with-deps chromium
COPY index.html vite.config.ts tsconfig.json eslint.config.js ./
COPY assets ./assets
RUN pip3 install --break-system-packages -r assets/textures/requirements.txt
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# better-sqlite3@13 requires Node >=22 (its prebuilt binary segfaults on
# Node 20 -- confirmed by reproducing on plain node:20-slim outside this
# image entirely). Both server stages need build tools for other natives.
FROM node:22-slim AS server-builder
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
# The server render queue reuses the shared scene builder; keep that source in
# the server build stage so TypeScript and the compiled runtime see the same code.
COPY src/ /app/src/
RUN npm run build

# ---- Stage 3: slim runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOMELY_AUTOMATION_PORT=9529
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=server-builder /app/server/package.json /app/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=server-builder /app/server/dist ./dist
COPY --from=frontend-builder /app/dist ./dist-static
COPY scripts/fetch-infisical-secrets.js scripts/entrypoint.sh ./scripts/
RUN chmod 755 ./scripts/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "dist/index.js"]
