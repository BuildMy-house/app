#!/bin/sh
set -eu

if [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
  secrets_file="$(mktemp)"
  trap 'rm -f "$secrets_file"' EXIT
  node /app/scripts/fetch-infisical-secrets.js > "$secrets_file"
  set -a
  . "$secrets_file"
  set +a
fi

exec "$@"
