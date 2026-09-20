#!/usr/bin/env bash
# Launch the BuildMyHouse MCP server (stdio). Used as the MCP "command" by
# Claude Desktop / ChatGPT desktop. Prints the WS port on stderr.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# MCP clients launch this script directly, so load the ignored local env file
# here instead of relying on the parent shell having sourced it.
for ENV_FILE in "$HERE/../../.env"; do
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
done
PYTHON="${HOMELY_MCP_PYTHON:-$HERE/.venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON=python3
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
exec "$PYTHON" "$HERE/server.py" "$@"
