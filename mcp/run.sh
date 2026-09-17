#!/usr/bin/env bash
# Launch the BuildMyHouse MCP server (stdio). Used as the MCP "command" by
# Claude Desktop / ChatGPT desktop. Prints the WS port on stderr.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${HOMELY_MCP_PYTHON:-$HERE/.venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON=python3
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
exec "$PYTHON" "$HERE/server.py" "$@"
