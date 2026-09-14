#!/bin/bash
# Download SH3D models from SourceForge and prepare them for import
# Usage: bash scripts/download-sh3d-models.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
WORK_DIR="$REPO_ROOT/.sh3d-scratch/extracted"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  Sweet Home 3D Model Downloader                               ║"
echo "║  Downloads and extracts models with textures for baking       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Create working directory
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# SourceForge direct download URLs for 3DModels-1.9.3
# These are the latest furniture model collections with textures
MODELS=(
  # Furniture
  "https://sourceforge.net/projects/sweethome3d/files/3DModels/3DModels-1.9.3.zip/download"
)

echo "Downloading SH3D models from SourceForge..."
echo "This may take 5-15 minutes depending on your connection."
echo ""

for url in "${MODELS[@]}"; do
  filename=$(basename "$url" .zip)
  if [ -f "$filename.zip" ]; then
    echo "✓ Already downloaded: $filename.zip"
  else
    echo "⬇ Downloading: $filename"
    curl -L -o "$filename.zip" "$url" 2>&1 | grep -E "^  [0-9]" || true
    echo ""
  fi
done

echo "Extracting archives..."
for file in *.zip; do
  if [ -f "$file" ]; then
    echo "📦 Extracting: $file"
    unzip -q "$file" || true
  fi
done

echo ""
echo "✓ SH3D models extracted to: $WORK_DIR"
echo ""
echo "Next steps:"
echo "  1. cd buildmyhouse"
echo "  2. npm run import:sh3d -- --skip-upload  (to convert to GLB with textures)"
echo "  3. Review the converted models"
echo "  4. Run: npm run import:sh3d -- --merge-catalog  (to update the catalog)"
echo ""
