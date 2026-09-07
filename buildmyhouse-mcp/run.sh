#!/usr/bin/env bash
# Launch the Homely MCP server (stdio). Used as the MCP "command" by
# Claude Desktop / ChatGPT desktop. Prints the WS port on stderr.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${HOMELY_MCP_VENV:-$HERE/../equivalence/.venv/bin/python}"
export PYTHONPATH="$HERE/../equivalence:${PYTHONPATH:-}"
exec "$VENV" "$HERE/server.py" "$@"
