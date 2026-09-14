#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Infisical Secrets Injection ─────────────────────────────────────────────
# Requires INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET (+ HOST_URL/PROJECT_ID).
# Fetches every secret in the project/environment and injects them into the
# environment. Actual credentials (AXIOM_TOKEN, POSTGRES_PASSWORD, etc.) live
# only in Infisical, never in .env or git — only the bootstrap identity does.
if [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
  echo "[infisical] Fetching secrets from Infisical (${INFISICAL_ENV:-dev})..."
  SECRETS_FILE=$(mktemp)
  trap "rm -f $SECRETS_FILE" EXIT

  if node "$SCRIPT_DIR/fetch-infisical-secrets.js" > "$SECRETS_FILE"; then
    echo "[infisical] Secrets loaded successfully"
    set -a
    source "$SECRETS_FILE"
    set +a
  else
    echo "[infisical] ERROR: Failed to fetch secrets from Infisical" >&2
    exit 1
  fi
else
  echo "[infisical] INFISICAL_UNIVERSAL_AUTH_CLIENT_ID not set; using .env or existing environment variables"
fi

# /opt/data is a fresh emptyDir on every pod recreation, mounted root:root.
# `chmod a+rwx` alone isn't enough: hermes-agent's own privilege-drop runs
# the gateway as a "hermes" system user, and its bootstrap re-tightens
# $HERMES_HOME to 700 for itself — but without matching ownership, that
# leaves the directory 700 root:root, locking the hermes user out of its
# own home entirely. Confirmed live: this crashed every single gateway
# turn with a raw PermissionError (agent/estop.py's get_state() has an
# unprotected .exists() call that doesn't catch it), because is_engaged()
# fails safe to "paused" on any stat error, then get_state() blows up
# trying to explain why. chown first so whatever hermes-agent chmods
# afterward is at least owned by the user it's actually locking out.
chown -R hermes:hermes /opt/data 2>/dev/null || true
chmod -R a+rwx /opt/data 2>/dev/null || true

# Sync config.yaml + SOUL.md from package into mounted volume (first-volume-only fix)
#
# SOUL.md goes to $HERMES_HOME, NOT /root/.hermes — hermes-agent's own
# get_default_hermes_root() docstring: "~/.hermes, or HERMES_HOME itself in
# Docker/custom deployments (e.g. /opt/data)". This container sets
# HERMES_HOME=/opt/data, so /root/.hermes/SOUL.md was never read by hermes
# at all. Confirmed live: /opt/data/SOUL.md held hermes-agent's own
# auto-seeded generic default persona (667 bytes, "You are Hermes Agent,
# built by Nous Research" — no mention of buildmy.house, the Board, or any
# engineering surface) the entire time this container has been running,
# while our real SOUL.md sat unread at the old wrong path.
if [ -f /opt/company-ops/hermes/config.yaml ]; then
  cp /opt/company-ops/hermes/config.yaml /opt/data/config.yaml
fi
if [ -f /opt/company-ops/hermes/SOUL.md ]; then
  cp /opt/company-ops/hermes/SOUL.md "${HERMES_HOME:-/opt/data}/SOUL.md"
fi

# Write secrets from environment to /opt/data/.env (hermes reads this at startup)
cat > /opt/data/.env << 'ENVEOF'
# Auto-generated from container environment — do not edit manually
ENVEOF

# DISCORD_BOT_TOKEN/ALLOWED_USERS/ALLOWED_CHANNELS/ALLOW_ALL_USERS/HOME_CHANNEL
# are read natively by hermes-agent's own gateway (no custom bridge script
# needed — see gateway/config_env.py + plugins/platforms/discord/adapter.py
# in the installed hermes-agent package for the full env var surface).
# HIL_CHANNEL/FINANCE_CHANNEL are separate: company_ops/human_interface.py
# posts to those directly via the Discord REST API, independent of the
# gateway entirely.
for key in DISCORD_BOT_TOKEN DISCORD_ALLOWED_USERS DISCORD_ALLOWED_CHANNELS \
           DISCORD_ALLOW_ALL_USERS DISCORD_HOME_CHANNEL \
           DISCORD_HIL_CHANNEL DISCORD_FINANCE_CHANNEL \
           NOUS_API_KEY OPENCODE_GO_API_KEY ZAI_CODING_PLAN_API_KEY TOKENROUTER_API_KEY \
           POSTGRES_PASSWORD COMPANY_PASSWORD OBSERVER_PASSWORD ANALYTICS_PASSWORD \
           COMPANY_DATABASE_URL OBSERVER_DATABASE_URL ANALYTICS_DATABASE_URL; do
  val="${!key:-}"
  if [[ -n "$val" ]]; then
    echo "${key}=${val}" >> /opt/data/.env
  fi
done

chmod 644 /opt/data/.env

# GitHub App private key — see engineering-entrypoint.sh for the fuller
# writeup; same fix, needed here for the memory-backup sync below.
if [ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]; then
  mkdir -p /etc/github
  printf '%s' "$GITHUB_APP_PRIVATE_KEY" > /etc/github/buildmyhouse-engineering-app.pem
  chmod 600 /etc/github/buildmyhouse-engineering-app.pem
fi

# ── Persistent memory backup (BuildMy-house/hermees-memory) ────────────────
# /opt/data is a fresh emptyDir on every pod recreation — nothing here
# survives a restart, let alone a move to a different machine. This mirrors
# the durable, non-secret parts (memories/, top-level *.md work products
# like buildmy_house_launch_plan.md) into hermes/ in the shared
# hermees-memory repo: restores once on a cold start (only when the local
# dir is empty, so it never clobbers newer local state with an older
# backup), then keeps pushing local changes back on an interval. Deliberate
# scope: memories/ and *.md only — never .env, never state.db/kanban.db
# (those are live, version-coupled to this exact hermes-agent build, and
# restoring a stale one into a different version on a new machine risks
# corruption; session/task continuity isn't what "memory" means here).
#
# Replaces a dead, never-working predecessor: this used to be an SSH-keyed
# clone of the hermees (diary) repo, but no SSH key was ever mounted in the
# k8s deployment (confirmed live: /root/.ssh had no key, /opt/hermees never
# even got created) — and diary posts are written by the engineering
# container via engineering_manager anyway, not by Hermes's own container,
# so this checkout was never actually used for anything even when it did
# clone successfully in an earlier (pre-k8s) deployment.
MEMORY_STAGING=/opt/hermees-memory

# Something keeps recreating /opt/data/memories root:root well after
# hermes-agent's own early startup — confirmed live: a fix that held for
# 90s+ at one point was back to root:root 21 minutes into the same pod's
# life, with no new failure in between (chown/chmod succeed instantly
# every time they're reapplied — this isn't a permissions bug, it's
# something recreating the directory on a cadence tighter than made sense
# to keep chasing with a single "run this sync function on a timer"
# design). Splitting the concerns: this fix is nearly free, so it runs on
# its own tight forever-loop, decoupled from the expensive git sync below
# — self-heals fast regardless of exactly when or how often the resets
# happen, without needing to fully pin down the cause.
fix_memories_perms() {
  mkdir -p /opt/data/memories
  chown hermes:hermes /opt/data/memories 2>/dev/null || true
  chmod a+rwx /opt/data/memories 2>/dev/null || true
}
( while true; do fix_memories_perms; sleep 15; done ) &

memory_sync_once() {
  local token
  token=$(node "$SCRIPT_DIR/github-app-token.js" 2>/dev/null) || { echo "[memory-sync] token mint failed" >&2; return 0; }
  local url="https://x-access-token:${token}@github.com/BuildMy-house/hermees-memory.git"
  if [[ -d "$MEMORY_STAGING/.git" ]]; then
    git -C "$MEMORY_STAGING" remote set-url origin "$url" 2>/dev/null
    git -C "$MEMORY_STAGING" pull --ff-only origin main >/dev/null 2>&1 || echo "[memory-sync] pull failed" >&2
  else
    rm -rf "$MEMORY_STAGING"
    git clone "$url" "$MEMORY_STAGING" >/dev/null 2>&1 || { echo "[memory-sync] clone failed" >&2; return 0; }
  fi
  mkdir -p "$MEMORY_STAGING/hermes/memories" "$MEMORY_STAGING/hermes/notes"
  fix_memories_perms
  if [ -z "$(ls -A /opt/data/memories 2>/dev/null)" ]; then
    cp -a "$MEMORY_STAGING/hermes/memories/." /opt/data/memories/ 2>/dev/null || true
  fi
  cp -a /opt/data/memories/. "$MEMORY_STAGING/hermes/memories/" 2>/dev/null || true
  find /opt/data -maxdepth 1 -iname "*.md" -not -name "SOUL.md" -exec cp -a {} "$MEMORY_STAGING/hermes/notes/" \; 2>/dev/null || true
  git -C "$MEMORY_STAGING" add hermes 2>/dev/null || true
  if ! git -C "$MEMORY_STAGING" diff --cached --quiet 2>/dev/null; then
    git -C "$MEMORY_STAGING" -c user.email="hermes@buildmy.house" -c user.name="Hermes" \
      commit -q -m "chore(memory): sync $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
    if git -C "$MEMORY_STAGING" push -q origin HEAD:main 2>&1; then
      echo "[memory-sync] pushed"
    else
      echo "[memory-sync] push failed" >&2
    fi
  fi
}
( while true; do memory_sync_once; sleep "${MEMORY_SYNC_INTERVAL_SECONDS:-300}"; done ) &

if [[ "${1:-}" == "hermes" ]]; then
  shift
  exec hermes "$@"
fi

exec company-ops "$@"
