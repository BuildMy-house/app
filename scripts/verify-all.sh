#!/usr/bin/env bash
# verify-all.sh — local equivalent of .github/workflows/ci.yml
# Runs every check CI runs: homely (lint + tsc + vitest + e2e) and equivalence (pytest).
# Exits non-zero if ANY check fails. Use --skip-e2e to skip the slow Playwright suite.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_E2E=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) SKIP_E2E=1 ;;
    -h|--help) echo "Usage: $0 [--skip-e2e]"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

declare -a RESULTS
ANY_FAIL=0

run_step() {
  local label="$1"; shift
  if "$@" >/tmp/verify-all.log 2>&1; then
    pass "$label"
    RESULTS+=("PASS|$label")
  else
    fail "$label"
    RESULTS+=("FAIL|$label")
    ANY_FAIL=1
    tail -20 /tmp/verify-all.log >&2
  fi
}

echo "=== buildmyhouse ==="
cd "$REPO/buildmyhouse"
run_step "lint      (eslint)"      npm run lint
run_step "typecheck (tsc)"        npx tsc --noEmit
run_step "unit      (vitest)"     npm test
if [ "$SKIP_E2E" -eq 0 ]; then
  run_step "e2e       (playwright)" npm run e2e
else
  printf '  \033[33mSKIP\033[0m  e2e       (playwright)\n'
  RESULTS+=("SKIP|e2e (playwright)")
fi

echo "=== equivalence ==="
cd "$REPO/equivalence"
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"
run_step "pytest    (equivalence)" "$PY" -m pytest -q

echo "=== summary ==="
for r in "${RESULTS[@]}"; do
  status="${r%%|*}"; label="${r#*|}"
  case "$status" in
    PASS) printf '  \033[32mPASS\033[0m  %s\n' "$label" ;;
    FAIL) printf '  \033[31mFAIL\033[0m  %s\n' "$label" ;;
    SKIP) printf '  \033[33mSKIP\033[0m  %s\n' "$label" ;;
  esac
done

exit "$ANY_FAIL"
