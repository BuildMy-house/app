#!/usr/bin/env bash
set -euo pipefail
pip install pyluxcore
python -c "import pyluxcore; print(f'LuxCoreRender {luxcore.LuxCoreVersion()} installed')"
